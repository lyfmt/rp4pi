import { pathToFileURL } from "node:url";
import type { PiLike, ExtensionContextLike } from "../../src/types/pi.ts";
import type { WriterClient } from "../../src/runtime/writer-client.ts";
import { resetRuntimeInfrastructureForTest } from "../../src/runtime/bootstrap.ts";
import { resetTurnListenersForTest } from "../../src/runtime/turn-events.ts";
import { resetHookPromptsForTest } from "../../src/hooks/pending-prompts.ts";

// The production runtime is now three independently-loaded extensions (core,
// two-pass-render, openviking-memory). They share infrastructure through the
// memoized bootstrap singleton, which must be reset between test cases so each
// case gets its own sqlite db instead of inheriting a previous case's. This
// helper activates all three in the order start.sh loads them, against a
// caller-supplied pi fake so existing extension tests keep exercising the full
// registration surface (tools + commands + hooks + renderer) in one call.
const core = await import(pathToFileURL(new URL("../../extensions/core.ts", import.meta.url).pathname).href);
const twoPass = await import(pathToFileURL(new URL("../../extensions/two-pass-render/index.ts", import.meta.url).pathname).href);
const ovMemory = await import(pathToFileURL(new URL("../../extensions/openviking-memory/index.ts", import.meta.url).pathname).href);

const activateCore = core.activate as typeof import("../../extensions/core.js").activate;
const activateTwoPass = twoPass.activate as typeof import("../../extensions/two-pass-render/index.js").activate;
const activateOvMemory = ovMemory.activate as typeof import("../../extensions/openviking-memory/index.js").activate;

export type ActivateAllOptions = {
  createWriterClient?: (ctx: ExtensionContextLike) => WriterClient;
  setTimeoutFn?: (callback: () => void, delayMs: number) => void;
  observeCompletion?: (completion: Promise<void>) => void;
};

// Every activation path resets the shared singletons first so a single-extension
// test (e.g. activateOvMemory for the renderer) never inherits a prior case's
// db handle or turn-rendered listeners. resetRuntimeInfrastructureForTest closes
// the cached db; resetTurnListenersForTest clears the event-bus subscriber set.
function resetShared(): void {
  resetRuntimeInfrastructureForTest();
  resetTurnListenersForTest();
  resetHookPromptsForTest();
}

export function activateAllExtensions(pi: PiLike, options: ActivateAllOptions = {}): void {
  resetShared();
  activateCore(pi);
  activateTwoPass(pi, {
    createWriterClient: options.createWriterClient,
    setTimeoutFn: options.setTimeoutFn,
    observeCompletion: options.observeCompletion
  });
  activateOvMemory(pi);
}

export { activateCore, activateTwoPass, activateOvMemory, resetShared };
