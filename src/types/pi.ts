import type { RuntimeMessage } from "../runtime/prose-message.ts";
import type { WriterClient } from "../runtime/writer-client.ts";
import type { OpenVikingClient } from "../ov/client.ts";

// This module is a faithful *structural subset* of the real pi extension API
// (`@earendil-works/pi-coding-agent`). It deliberately does not import the SDK
// so the runtime stays unit-testable with plain fakes, but every shape here
// must match the real contract: `start.sh` runs
// `pi -e ./extensions/core.ts -e ./extensions/two-pass-render/index.ts -e ./extensions/openviking-memory/index.ts`,
// so the real `ExtensionAPI` is what each `activate()` receives in production.
// If a member here disagrees with the SDK, production silently no-ops — which
// is exactly the bug class this file is meant to prevent.

/** Subset of pi `ExtensionUIContext` we use. */
export interface ExtensionUIContextLike {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWorkingMessage(message?: string): void;
  /**
   * Set a widget above/below the editor. Accepts prerendered lines or a
   * component factory; pass `undefined` as content to remove the widget.
   * Optional because headless contexts (rpc/json/print, tests) omit it.
   */
  setWidget?(
    key: string,
    content: string[] | ((tui: PiTuiHostLike, theme: PiThemeLike) => PiComponentLike) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" }
  ): void;
  /** Set footer status text for a key; `undefined` clears it. */
  setStatus?(key: string, text: string | undefined): void;
  /**
   * Show a custom focus-grabbing component and resolve with whatever it passes
   * to `done`. The factory receives pi's TUI host, theme, keybindings, and the
   * `done` callback. We deliberately keep `tui`/`theme`/`keybindings` as
   * structural shapes (not the real SDK classes) so this module stays free of
   * the `@earendil-works/pi-tui` import the project does not install locally.
   */
  custom?<T>(
    factory: (tui: PiTuiHostLike, theme: PiThemeLike, keybindings: PiKeybindingsLike, done: (result: T) => void) => PiComponentLike,
    options?: { overlay?: boolean }
  ): Promise<T>;
}

/** Component contract pi renders: `render` to lines, optional key handling. */
export interface PiComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

/** Subset of pi's TUI host we touch from a custom component. */
export interface PiTuiHostLike {
  requestRender(force?: boolean): void;
}

/** Subset of pi's Theme used for coloring custom-component output. */
export interface PiThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Subset of pi's KeybindingsManager: match raw input against an action id. */
export interface PiKeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

/** Subset of pi `ReadonlySessionManager` we use. Session identity lives here. */
export interface SessionManagerLike {
  getSessionId(): string;
  getSessionDir?(): string;
  getEntries?(): unknown[];
  getLeafId?(): string;
}

/**
 * Subset of pi `ExtensionContext` passed to every tool `execute`, command
 * `handler`, and event handler as the trailing `ctx` argument.
 */
export interface ExtensionContextLike {
  sessionManager: SessionManagerLike;
  signal?: AbortSignal;
  hasUI?: boolean;
  /** Run mode; "tui" gates terminal-only UI such as custom components. */
  mode?: "tui" | "rpc" | "json" | "print";
  ui?: ExtensionUIContextLike;
  isIdle?(): boolean;
  modelRegistry?: {
    find(provider: string, modelId: string): unknown;
    getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
  };
}

/**
 * Subset of pi `ExtensionCommandContext`. Commands receive session-control
 * capabilities the plain context does not expose.
 */
export interface ExtensionCommandContextLike extends ExtensionContextLike {
  waitForIdle?(): Promise<void>;
  /**
   * Optional host-provided turn rerun hook. Some Pi runtimes expose a direct
   * rerun entrypoint; others do not, so command wiring must detect and degrade
   * clearly instead of hardcoding production to "unavailable".
   */
  rerunTurn?(message: string): void | Promise<void>;
}

/** Matches pi `AgentToolResult<T>` content-array shape. */
export interface ToolResultContent {
  type: "text";
  text: string;
}

export interface AgentToolResult<TDetails = unknown> {
  content: ToolResultContent[];
  details: TDetails;
  terminate?: boolean;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partial: AgentToolResult<TDetails>) => void;

/**
 * Matches the real pi tool `execute` arity:
 * `(toolCallId, params, signal, onUpdate, ctx)`. The pre-fix scaffold used
 * `(input, context)`, which silently read `toolCallId` as `input` and `params`
 * as `context` — the root cause of "参数都未转化".
 */
export type ToolDefinition<TResult extends AgentToolResult = AgentToolResult> = {
  name: string;
  /** Human-readable label for the TUI. Real pi requires this. */
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  /** pi compatibility shim: normalize raw args before schema validation. */
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContextLike
  ) => TResult | Promise<TResult>;
};

/** Options accepted by `pi.registerCommand(name, options)`. */
export interface RegisteredCommandOptions {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => unknown;
  handler: (args: string, ctx: ExtensionCommandContextLike) => Promise<void> | void;
}

/** Result returned from a `resources_discover` handler. */
export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

/** Result returned from a `context` handler. */
export interface ContextEventResult {
  messages?: RuntimeMessage[];
}

/** Message accepted by `pi.sendMessage`. */
export interface OutboundCustomMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
}

/**
 * Faithful subset of pi `ExtensionAPI`. Only the members the RP runtime
 * actually uses are declared; all are required (not optional-chained) so a
 * drift from the real SDK surfaces as a type error here rather than a silent
 * production no-op.
 */
export interface PiLike {
  on(
    event: "resources_discover",
    handler: (event: unknown, ctx: ExtensionContextLike) => ResourcesDiscoverResult | Promise<ResourcesDiscoverResult> | void
  ): void;
  on(event: "before_agent_start", handler: (event: unknown, ctx: ExtensionContextLike) => unknown): void;
  on(
    event: "context",
    handler: (event: { messages: RuntimeMessage[] }, ctx: ExtensionContextLike) => ContextEventResult | Promise<ContextEventResult> | void
  ): void;
  on(event: "agent_end", handler: (event: unknown, ctx: ExtensionContextLike) => void | Promise<void>): void;
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContextLike) => void | Promise<void>): void;
  on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => unknown): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, options: RegisteredCommandOptions): void;
  registerMessageRenderer?(
    customType: string,
    renderer: (message: unknown, options: unknown, theme?: PiThemeLike) => PiComponentLike | undefined
  ): void;
  sendMessage(
    message: OutboundCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
  ): void;
  appendEntry?(customType: string, data?: unknown): void;
}

/** Resolve the active pi session id from a tool/command/event context. */
export function resolveSessionId(ctx: ExtensionContextLike | undefined): string | undefined {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Optional capabilities the production extension wires from real services but
 * that the SDK does not provide directly (writer rendering, long-term memory).
 * These are injected at registration time, not read off `PiLike`.
 */
export interface RuntimeServices {
  createWriterClient?: (agentName: string) => WriterClient;
  createOpenVikingClient?: () => OpenVikingClient | undefined;
  writeCustomMessage?: (message: RuntimeMessage) => void | Promise<void>;
}
