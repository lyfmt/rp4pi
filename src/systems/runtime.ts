import { randomUUID } from "node:crypto";

import type { RpDatabase } from "../state/sqlite.ts";
import { activateSystemSave } from "./activation.ts";
import { canonicalJson, fingerprintBatch } from "./canonical-json.ts";
import {
  ensureSaveCommitMetadata,
  readCommitReceipt,
  readSaveCommitMetadata,
  writeCommitReceipt,
  writeSaveRevision
} from "./commit-repository.ts";
import { SystemRuntimeError, type SystemRuntimeErrorCode } from "./errors.ts";
import type { SystemRegistry } from "./registry.ts";
import { readSystemState, writeSystemState } from "./repository.ts";
import type {
  ActivatedSystemSave,
  RuntimeProjectionRequest,
  RuntimeStateCommitRequest,
  StateCommitReceipt,
  SystemDefinition,
  SystemCommandContext,
  SystemOperation,
  SystemProjection,
  SystemRuntimeLifecycle,
  ProjectionContext
} from "./types.ts";

type ErasedCommand = {
  execute(context: SystemCommandContext, state: unknown, input: unknown): unknown;
};

type ErasedProject = (context: ProjectionContext, state: unknown) => unknown;

type CandidateSystemState = {
  definition: SystemDefinition<unknown>;
  state: unknown;
};

export type CreateSystemRuntimeOptions = Readonly<{
  db: RpDatabase;
  registry: SystemRegistry;
  capabilities?: ReadonlyMap<string, unknown>;
}>;

export function createSystemRuntime(options: CreateSystemRuntimeOptions): SystemRuntimeLifecycle {
  const { db, registry } = options;
  const capabilities = new Map(options.capabilities ?? []);
  const readySaves = new Set<string>();

  return Object.freeze({
    activateSave(saveId: string): ActivatedSystemSave {
      activateSystemSave({ db, saveId, registry });
      const metadata = ensureSaveCommitMetadata(db, saveId);
      readySaves.add(saveId);
      return Object.freeze({ saveId, ...metadata });
    },

    invalidateSave(saveId: string): void {
      readySaves.delete(saveId);
    },

    async commit(request: RuntimeStateCommitRequest): Promise<StateCommitReceipt> {
      assertCommitEnvelope(request);
      const requestHash = fingerprintBatch(request.operations);
      return commitOperationBatch(
        db,
        registry,
        capabilities,
        readySaves,
        request,
        requestHash
      );
    },

    async project(request: RuntimeProjectionRequest): Promise<SystemProjection[]> {
      assertReady(readySaves, request.saveId);
      return projectSave(db, registry, request);
    }
  });
}

function commitOperationBatch(
  db: RpDatabase,
  registry: SystemRegistry,
  capabilities: ReadonlyMap<string, unknown>,
  readySaves: ReadonlySet<string>,
  request: RuntimeStateCommitRequest,
  requestHash: string
): StateCommitReceipt {
  let transactionActive = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionActive = true;

    assertReady(readySaves, request.saveId);
    const metadata = requireMetadata(db, request.saveId);
    const existing = readCommitReceipt<StateCommitReceipt>(
      db,
      request.saveId,
      metadata.branchEpoch,
      request.requestId
    );
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new SystemRuntimeError("IDEMPOTENCY_CONFLICT", {
          saveId: request.saveId,
          branchEpoch: metadata.branchEpoch,
          requestId: request.requestId
        });
      }
      db.exec("COMMIT");
      transactionActive = false;
      return existing.receipt;
    }

    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== metadata.revision
    ) {
      throw new SystemRuntimeError("STATE_COMMIT_CONFLICT", {
        saveId: request.saveId,
        expectedRevision: request.expectedRevision,
        currentRevision: metadata.revision
      });
    }

    const candidates = loadCandidateStates(db, registry, request.saveId);
    const changedSystems = new Set<string>();
    const operationReceipts: Array<{ system: string; command: string; result: unknown }> = [];

    for (let index = 0; index < request.operations.length; index += 1) {
      const operation = request.operations[index]!;
      const definition = requireOperationDefinition(registry, operation, index);
      const candidate = candidates.get(definition.name);
      if (candidate === undefined) {
        throw operationError("SYSTEM_NOT_READY", operation, index, { saveId: request.saveId });
      }
      const command = definition.commands[operation.command];
      if (command === undefined) {
        throw operationError("COMMAND_NOT_FOUND", operation, index);
      }

      let input: unknown;
      try {
        input = command.parseInput(operation.input);
        if (isPromiseLike(input)) {
          throw new TypeError("command input parser must be synchronous");
        }
      } catch (cause) {
        throw operationError(
          "COMMAND_INPUT_INVALID",
          operation,
          index,
          { reason: "input parser rejected input" },
          cause
        );
      }

      let outcome: unknown;
      try {
        const execute = command.execute as unknown as ErasedCommand["execute"];
        outcome = execute(
          {
            read(dependency: string): unknown {
              return readCandidateProjection(
                candidates,
                definition,
                dependency,
                operation,
                index
              );
            },
            capability(name: string): unknown {
              if (!definition.capabilities.includes(name) || !capabilities.has(name)) {
                throw operationError("CAPABILITY_UNAVAILABLE", operation, index, {
                  capability: name
                });
              }
              return capabilities.get(name);
            }
          },
          candidate.state,
          input
        );
        if (isPromiseLike(outcome)) {
          throw new TypeError("command handler must be synchronous");
        }
      } catch (cause) {
        if (isOperationRuntimeError(cause, operation, index)) {
          throw cause;
        }
        throw operationError(
          "COMMAND_FAILED",
          operation,
          index,
          { reason: "command handler failed" },
          cause
        );
      }
      if (typeof outcome !== "object" || outcome === null) {
        throw operationError("COMMAND_FAILED", operation, index, {
          reason: "command handler returned an invalid result"
        });
      }

      const { nextState, result } = outcome as { nextState?: unknown; result?: unknown };
      const parsedNextState = parseState(definition, nextState, operation, index);
      try {
        canonicalJson(parsedNextState);
      } catch (cause) {
        throw operationError(
          "SYSTEM_STATE_INVALID",
          operation,
          index,
          { reason: "next state is not JSON-compatible" },
          cause
        );
      }
      try {
        canonicalJson(result);
      } catch (cause) {
        throw operationError(
          "COMMAND_FAILED",
          operation,
          index,
          { reason: "command result is not JSON-compatible" },
          cause
        );
      }

      candidates.set(definition.name, { definition, state: parsedNextState });
      changedSystems.add(definition.name);
      operationReceipts.push({
        system: operation.system,
        command: operation.command,
        result
      });
    }

    const revision = metadata.revision + 1;
    const receipt: StateCommitReceipt = {
      commitId: randomUUID(),
      revision,
      branchEpoch: metadata.branchEpoch,
      operations: operationReceipts
    };

    for (const definition of registry.definitions()) {
      if (!changedSystems.has(definition.name)) {
        continue;
      }
      const candidate = candidates.get(definition.name)!;
      writeSystemState(db, request.saveId, {
        name: definition.name,
        version: definition.version,
        payload: candidate.state
      });
    }
    writeSaveRevision(db, request.saveId, revision);
    writeCommitReceipt(
      db,
      request.saveId,
      metadata.branchEpoch,
      request.requestId,
      requestHash,
      receipt
    );

    db.exec("COMMIT");
    transactionActive = false;
    return receipt;
  } catch (error) {
    if (transactionActive) {
      rollback(db);
    }
    throw error;
  }
}

function loadCandidateStates(
  db: RpDatabase,
  registry: SystemRegistry,
  saveId: string
): Map<string, CandidateSystemState> {
  const candidates = new Map<string, CandidateSystemState>();
  for (const definition of registry.definitions()) {
    const stored = readSystemState(db, saveId, definition.name);
    if (stored === undefined) {
      throw new SystemRuntimeError("SYSTEM_NOT_READY", {
        saveId,
        system: definition.name
      });
    }
    if (stored.version > definition.version) {
      throw new SystemRuntimeError("SYSTEM_VERSION_FUTURE", {
        saveId,
        system: definition.name,
        storedVersion: stored.version,
        currentVersion: definition.version
      });
    }
    if (stored.version !== definition.version) {
      throw new SystemRuntimeError("SYSTEM_NOT_READY", {
        saveId,
        system: definition.name,
        storedVersion: stored.version,
        currentVersion: definition.version
      });
    }

    let state: unknown;
    try {
      state = definition.parse(stored.payload);
      if (isPromiseLike(state)) {
        throw new TypeError("system parser must be synchronous");
      }
    } catch (cause) {
      throw new SystemRuntimeError(
        "SYSTEM_STATE_INVALID",
        { saveId, system: definition.name, phase: "commit", reason: "system parser rejected state" },
        { cause }
      );
    }
    candidates.set(definition.name, { definition, state });
  }
  return candidates;
}

function readCandidateProjection(
  candidates: ReadonlyMap<string, CandidateSystemState>,
  caller: SystemDefinition<unknown>,
  dependency: string,
  operation: SystemOperation,
  index: number
): unknown {
  if (!caller.dependsOn.includes(dependency)) {
    throw operationError("DEPENDENCY_UNAVAILABLE", operation, index, {
      dependency,
      reason: "dependency was not declared"
    });
  }
  const target = candidates.get(dependency);
  if (target === undefined) {
    throw operationError("DEPENDENCY_UNAVAILABLE", operation, index, {
      dependency,
      reason: "dependency is not ready"
    });
  }

  try {
    const project = target.definition.project as unknown as ErasedProject;
    const value = project(
      { audience: { kind: "system", name: caller.name } },
      target.state
    );
    if (isPromiseLike(value)) {
      throw new TypeError("system projection must be synchronous");
    }
    canonicalJson(value);
    return value;
  } catch (cause) {
    throw operationError(
      "COMMAND_FAILED",
      operation,
      index,
      {
        dependency,
        phase: "dependency_projection",
        reason: "dependency projection failed"
      },
      cause
    );
  }
}

function projectSave(
  db: RpDatabase,
  registry: SystemRegistry,
  request: RuntimeProjectionRequest
): SystemProjection[] {
  let transactionActive = false;
  try {
    db.exec("BEGIN");
    transactionActive = true;
    const metadata = requireMetadata(db, request.saveId);
    const names = request.systems ?? registry.names();
    const projections = names.map((name) => {
      const definition = registry.require(name);
      const stored = readSystemState(db, request.saveId, name);
      if (stored === undefined || stored.version !== definition.version) {
        throw new SystemRuntimeError("SYSTEM_NOT_READY", { saveId: request.saveId, system: name });
      }

      const state = parseProjectedState(definition, stored.payload);
      let value: unknown;
      try {
        const project = definition.project as unknown as ErasedProject;
        value = project({ audience: request.audience }, state);
        if (isPromiseLike(value)) {
          throw new TypeError("system projection must be synchronous");
        }
        canonicalJson(value);
      } catch (cause) {
        throw new SystemRuntimeError(
          "COMMAND_FAILED",
          { system: name, phase: "projection", reason: "projection failed" },
          { cause }
        );
      }
      return { system: name, revision: metadata.revision, value };
    });

    db.exec("COMMIT");
    transactionActive = false;
    return projections;
  } catch (error) {
    if (transactionActive) {
      rollback(db);
    }
    throw error;
  }
}

function parseState(
  definition: SystemDefinition<unknown>,
  payload: unknown,
  operation: SystemOperation,
  index: number
): unknown {
  try {
    const state = definition.parse(payload);
    if (isPromiseLike(state)) {
      throw new TypeError("system parser must be synchronous");
    }
    return state;
  } catch (cause) {
    throw operationError(
      "SYSTEM_STATE_INVALID",
      operation,
      index,
      { reason: "system parser rejected state" },
      cause
    );
  }
}

function parseProjectedState(definition: SystemDefinition<unknown>, payload: unknown): unknown {
  try {
    const state = definition.parse(payload);
    if (isPromiseLike(state)) {
      throw new TypeError("system parser must be synchronous");
    }
    return state;
  } catch (cause) {
    throw new SystemRuntimeError(
      "SYSTEM_STATE_INVALID",
      { system: definition.name, phase: "projection", reason: "system parser rejected state" },
      { cause }
    );
  }
}

function requireOperationDefinition(
  registry: SystemRegistry,
  operation: SystemOperation,
  index: number
): SystemDefinition<unknown> {
  try {
    return registry.require(operation.system);
  } catch (cause) {
    throw operationError("SYSTEM_NOT_REGISTERED", operation, index, undefined, cause);
  }
}

function requireMetadata(db: RpDatabase, saveId: string) {
  const metadata = readSaveCommitMetadata(db, saveId);
  if (metadata === undefined) {
    throw new SystemRuntimeError("SYSTEM_NOT_READY", { saveId });
  }
  return metadata;
}

function assertReady(readySaves: ReadonlySet<string>, saveId: string): void {
  if (!readySaves.has(saveId)) {
    throw new SystemRuntimeError("SYSTEM_NOT_READY", { saveId });
  }
}

function assertCommitEnvelope(request: RuntimeStateCommitRequest): void {
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new SystemRuntimeError("COMMAND_FAILED", {
      reason: "operations must be a non-empty array"
    });
  }
  if (typeof request.requestId !== "string" || request.requestId.length === 0) {
    throw new SystemRuntimeError("COMMAND_FAILED", { reason: "requestId must be non-empty" });
  }
}

function operationError(
  code: SystemRuntimeErrorCode,
  operation: SystemOperation,
  index: number,
  context: Readonly<Record<string, unknown>> = {},
  cause?: unknown
): SystemRuntimeError {
  return new SystemRuntimeError(
    code,
    { index, system: operation.system, command: operation.command, ...context },
    cause === undefined ? undefined : { cause }
  );
}

function isOperationRuntimeError(
  error: unknown,
  operation: SystemOperation,
  index: number
): error is SystemRuntimeError {
  return (
    error instanceof SystemRuntimeError &&
    error.context.index === index &&
    error.context.system === operation.system &&
    error.context.command === operation.command
  );
}

function rollback(db: RpDatabase): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the runtime error that caused the rollback.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
