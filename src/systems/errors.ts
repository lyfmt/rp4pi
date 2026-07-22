export type SystemRuntimeErrorCode =
  | "REGISTRATION_INVALID"
  | "DEPENDENCY_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "SYSTEM_NOT_REGISTERED"
  | "SYSTEM_NOT_READY"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_INPUT_INVALID"
  | "SYSTEM_STATE_INVALID"
  | "SYSTEM_VERSION_FUTURE"
  | "MIGRATION_FAILED"
  | "STATE_COMMIT_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "SNAPSHOT_INCOMPATIBLE"
  | "COMMAND_FAILED";

export class SystemRuntimeError extends Error {
  readonly code: SystemRuntimeErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: SystemRuntimeErrorCode,
    context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "SystemRuntimeError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}
