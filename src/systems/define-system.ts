import { SystemRuntimeError } from "./errors.ts";
import type {
  SystemCommandDefinition,
  SystemDefinition,
  SystemDefinitionInput
} from "./types.ts";

const SYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const COMMAND_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
// Pi's Jiti loader and Node's native loader can evaluate this module separately.
const SYSTEM_DEFINITION_BRAND = Symbol.for("my-rp-agent:SystemDefinition");

type BrandedSystemDefinition = SystemDefinition<unknown> & {
  readonly [SYSTEM_DEFINITION_BRAND]: true;
};

export function defineSystem<State>(input: SystemDefinitionInput<State>): SystemDefinition<State> {
  assertDefinitionInput(input);

  const commands = Object.fromEntries(
    Object.entries(input.commands).map(([key, command]) => [key, Object.freeze({ ...command })])
  ) as Record<string, SystemCommandDefinition<State>>;

  const definition = {
    ...input,
    dependsOn: Object.freeze([...(input.dependsOn ?? [])]),
    capabilities: Object.freeze([...(input.capabilities ?? [])]),
    commands: Object.freeze(commands)
  } as SystemDefinition<State> & { [SYSTEM_DEFINITION_BRAND]: true };

  Object.defineProperty(definition, SYSTEM_DEFINITION_BRAND, {
    value: true,
    enumerable: false
  });
  return Object.freeze(definition);
}

export function isSystemDefinition(value: unknown): value is SystemDefinition<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<BrandedSystemDefinition>)[SYSTEM_DEFINITION_BRAND] === true
  );
}

function assertDefinitionInput<State>(input: SystemDefinitionInput<State>): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalidRegistration({ reason: "definition must be an object" });
  }
  if (typeof input.name !== "string" || !SYSTEM_NAME_PATTERN.test(input.name)) {
    invalidRegistration({ system: input.name, reason: "invalid system name" });
  }
  if (!Number.isInteger(input.version) || input.version <= 0) {
    invalidRegistration({ system: input.name, version: input.version, reason: "version must be a positive integer" });
  }
  assertNameList(input.dependsOn, "dependsOn", input.name);
  assertNameList(input.capabilities, "capabilities", input.name);
  if (
    typeof input.initialize !== "function" ||
    typeof input.parse !== "function" ||
    typeof input.project !== "function" ||
    (input.migrate !== undefined && typeof input.migrate !== "function")
  ) {
    invalidRegistration({ system: input.name, reason: "invalid lifecycle function" });
  }
  if (typeof input.commands !== "object" || input.commands === null || Array.isArray(input.commands)) {
    invalidRegistration({ system: input.name, reason: "commands must be an object" });
  }
  for (const [key, command] of Object.entries(input.commands)) {
    if (!COMMAND_KEY_PATTERN.test(key)) {
      invalidRegistration({ system: input.name, command: key, reason: "invalid command key" });
    }
    if (
      typeof command !== "object" ||
      command === null ||
      typeof command.parseInput !== "function" ||
      typeof command.execute !== "function"
    ) {
      invalidRegistration({ system: input.name, command: key, reason: "invalid command definition" });
    }
  }
}

function assertNameList(value: readonly string[] | undefined, field: string, system: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !SYSTEM_NAME_PATTERN.test(name))) {
    invalidRegistration({ system, field, reason: `${field} must contain valid names` });
  }
}

function invalidRegistration(context: Readonly<Record<string, unknown>>): never {
  throw new SystemRuntimeError("REGISTRATION_INVALID", context);
}
