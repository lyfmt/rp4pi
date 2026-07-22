import { createAgentEndHandler } from "../../src/runtime/turn-hook.ts";
import { createConfiguredWriterClient, type WriterClient } from "../../src/runtime/writer-client.ts";
import { buildWriterTools, loadWritingGuideBodies, writingGuideCatalogue } from "../../src/runtime/writer-tools.ts";
import { getRuntimeInfrastructure } from "../../src/runtime/bootstrap.ts";
import { findProjectRoot } from "../../src/runtime/paths.ts";
import type { ExtensionContextLike, PiLike } from "../../src/types/pi.ts";

// Pass B (rendering): when the GM loop ends (submit_direction_packet terminated
// it), render the packet into player-facing prose via the writer and deliver it
// as a custom message once the agent is idle. This is a standalone extension —
// disabling it (drop the `-e` flag) leaves the core game running without
// rendered prose. It shares db/stateStore with the core extension through the
// memoized bootstrap singleton, and broadcasts the rendered turn over the
// in-process turn-events bus for the OpenViking-memory extension to consume.
//
// `createWriterClient` is injected (tests substitute a fake); the production
// default builds a model-backed client. Its arity is (ctx) => WriterClient —
// the live context is needed to resolve the writer model and auth.
export type TwoPassRenderServices = {
  createWriterClient?: (ctx: ExtensionContextLike) => WriterClient;
  setTimeoutFn?: (callback: () => void, delayMs: number) => void;
  observeCompletion?: (completion: Promise<void>) => void;
};

export function activate(pi: PiLike, services: TwoPassRenderServices = {}): void {
  const projectRoot = findProjectRoot(import.meta.url);
  const { db, stateStore, systemRuntime, storySnapshots, ovClient, world } =
    getRuntimeInfrastructure(projectRoot);

  pi.on("agent_end", createAgentEndHandler({
    db,
    stateStore,
    storySnapshots,
    createWriterClient: (ctx) =>
      services.createWriterClient?.(ctx) ??
      // The writer is a read-only agent (W-C): it may look up memory / status /
      // world writing guides before it writes, then renders prose. It shares the
      // GM's bootstrap db/stateStore/ovClient (read-only paths only) and reads the
      // world's declared writing guides on demand.
      createConfiguredWriterClient({
        projectRoot,
        ctx,
        tools: buildWriterTools({
          db,
          stateStore,
          systemRuntime,
          ovClient,
          writingGuides: world.writingGuides,
          worldName: world.name
        }),
        writingGuides: writingGuideCatalogue(world.writingGuides),
        // W-G: the draft passes a mandatory revision pipeline (style enhance →
        // inertia + cliché critics → bounded rewrite). The world declares the
        // banned-word register and the guides the enhancer draws on.
        revision: {
          bannedWords: world.revision.bannedWords,
          loadGuideBodies: () => loadWritingGuideBodies(world.writingGuides)
        },
        promptTemplate: world.promptTemplates.writer
      }),
    sendMessage: (message, options) => pi.sendMessage(message, options),
    setTimeoutFn: services.setTimeoutFn,
    observeCompletion: services.observeCompletion
  }));
}

export default activate;
