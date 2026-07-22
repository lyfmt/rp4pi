export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SystemCommandContext = Readonly<{
  read(system: string): unknown;
  capability(name: string): unknown;
}>;

export type ProjectionAudience =
  | Readonly<{ kind: "gm" }>
  | Readonly<{ kind: "writer" }>
  | Readonly<{ kind: "player" }>
  | Readonly<{ kind: "system"; name: string }>;

export type SystemOperation = Readonly<{
  system: string;
  command: string;
  input: unknown;
}>;

export type StateCommitRequest = Readonly<{
  requestId: string;
  expectedRevision?: number;
  operations: readonly [SystemOperation, ...SystemOperation[]];
}>;

export type RuntimeCaller =
  | Readonly<{ kind: "gm"; sessionId: string }>
  | Readonly<{ kind: "system"; name: string }>
  | Readonly<{ kind: "worker"; name: string }>;

export type StateCommitReceipt = Readonly<{
  commitId: string;
  revision: number;
  branchEpoch: number;
  operations: readonly Readonly<{
    system: string;
    command: string;
    result: unknown;
  }>[];
}>;

export type ProjectionRequest = Readonly<{
  audience: ProjectionAudience;
  systems?: readonly string[];
}>;

export type SystemProjection = Readonly<{
  system: string;
  revision: number;
  value: unknown;
}>;

export type RuntimeStateCommitRequest = StateCommitRequest & {
  saveId: string;
  caller: RuntimeCaller;
};

export type RuntimeProjectionRequest = ProjectionRequest & { saveId: string };

export type ActivatedSystemSave = Readonly<{
  saveId: string;
  revision: number;
  branchEpoch: number;
}>;

export type SystemRuntime = {
  commit(request: RuntimeStateCommitRequest): Promise<StateCommitReceipt>;
  project(request: RuntimeProjectionRequest): Promise<SystemProjection[]>;
};

export type SystemRuntimeLifecycle = SystemRuntime & {
  activateSave(saveId: string): ActivatedSystemSave;
  invalidateSave?(saveId: string): void;
};

export type ProjectionContext = Readonly<{
  audience: ProjectionAudience;
}>;

export type SystemCommandDefinition<State> = Readonly<{
  parseInput(input: unknown): unknown;
  execute(
    context: SystemCommandContext,
    state: Readonly<State>,
    input: unknown
  ): { nextState: unknown; result: unknown };
}>;

export type SystemDefinition<State> = Readonly<{
  name: string;
  version: number;
  dependsOn: readonly string[];
  capabilities: readonly string[];
  initialize(): unknown;
  parse(payload: unknown): State;
  migrate?: (fromVersion: number, payload: unknown) => { version: number; payload: unknown };
  commands: Readonly<Record<string, SystemCommandDefinition<State>>>;
  project(context: ProjectionContext, state: Readonly<State>): unknown;
}>;

export type SystemDefinitionInput<State> = Omit<SystemDefinition<State>, "dependsOn" | "capabilities"> &
  Readonly<{
    dependsOn?: readonly string[];
    capabilities?: readonly string[];
  }>;
