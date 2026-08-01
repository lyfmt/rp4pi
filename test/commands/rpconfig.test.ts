import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listRpModelTargets,
  registerRpConfigCommand,
  writeRpModelSelection,
  type RpModelTarget,
  type RpSubagentModelTarget
} from "../../src/commands/rpconfig.ts";
import type { PiLike } from "../../src/types/pi.ts";

function createProject(settings: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "rp-rpconfig-"));
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  writeFileSync(join(root, ".pi", "agent", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return root;
}

function readSettings(root: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, ".pi", "agent", "settings.json"), "utf8")) as Record<string, any>;
}

function findTarget(targets: readonly RpModelTarget[], id: string): RpModelTarget {
  const target = targets.find((candidate) => candidate.id === id);
  assert.ok(target, `missing target ${id}`);
  return target;
}

const subagents: RpSubagentModelTarget[] = [
  { name: "npc-generator", model: "world-provider/world-npc", thinking: "medium" },
  { name: "wounded-messenger", model: "world-provider/org/actor-model", thinking: "medium" },
  { name: "forged-scholar" }
];

test("lists writer, revision, and RP subagent targets with effective model fallbacks", () => {
  const root = createProject({
    defaultProvider: "clinepass",
    defaultModel: "cline-pass/glm-5.2",
    writer: {
      provider: "writer-provider",
      model: "org/writer-model",
      thinking: "high"
    },
    writerAgents: {
      styleEnhancer: {
        provider: "style-provider",
        model: "org/style-model",
        thinking: "medium"
      },
      clicheCritic: {
        provider: "critic-provider",
        model: "critic-model",
        thinking: "low"
      }
    },
    rpSubagents: {
      "npc-generator": {
        model: "opencode-go/deepseek-v4-pro",
        thinking: "high"
      }
    }
  });

  try {
    const targets = listRpModelTargets(root, subagents);

    assert.deepEqual(targets.map((target) => target.id), [
      "writer",
      "writerAgents.styleEnhancer",
      "writerAgents.inertiaCritic",
      "writerAgents.clicheCritic",
      "rpSubagents.npc-generator",
      "rpSubagents.wounded-messenger",
      "rpSubagents.forged-scholar"
    ]);
    assert.deepEqual(findTarget(targets, "writer").current, {
      provider: "writer-provider",
      id: "org/writer-model"
    });
    assert.deepEqual(findTarget(targets, "writerAgents.styleEnhancer").current, {
      provider: "style-provider",
      id: "org/style-model"
    });
    assert.deepEqual(findTarget(targets, "writerAgents.inertiaCritic").current, {
      provider: "writer-provider",
      id: "org/writer-model"
    });
    assert.equal(findTarget(targets, "writerAgents.inertiaCritic").thinking, "high");
    assert.deepEqual(findTarget(targets, "rpSubagents.npc-generator").current, {
      provider: "opencode-go",
      id: "deepseek-v4-pro"
    });
    assert.deepEqual(findTarget(targets, "rpSubagents.wounded-messenger").current, {
      provider: "world-provider",
      id: "org/actor-model"
    });
    assert.deepEqual(findTarget(targets, "rpSubagents.forged-scholar").current, {
      provider: "clinepass",
      id: "cline-pass/glm-5.2"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updates only the selected writer setting and preserves unrelated configuration", () => {
  const root = createProject({
    theme: "dark",
    defaultProvider: "default-provider",
    defaultModel: "default-model",
    writer: {
      provider: "old-provider",
      model: "old-model",
      thinking: "high",
      custom: "preserve-me"
    },
    openViking: {
      url: "http://127.0.0.1:1933",
      apiKey: "local-test-key",
      account: "test-account"
    }
  });

  try {
    const target = findTarget(listRpModelTargets(root, []), "writer");
    writeRpModelSelection(root, target, { provider: "new-provider", id: "org/new-model" });

    const settings = readSettings(root);
    assert.deepEqual(settings.writer, {
      provider: "new-provider",
      model: "org/new-model",
      thinking: "high",
      custom: "preserve-me"
    });
    assert.deepEqual(settings.openViking, {
      url: "http://127.0.0.1:1933",
      apiKey: "local-test-key",
      account: "test-account"
    });
    assert.equal(settings.theme, "dark");
    assert.equal(
      readdirSync(join(root, ".pi", "agent")).some((entry) => entry.includes(".tmp")),
      false,
      "atomic write temp file should be cleaned up"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializes inherited thinking when a revision stage gets its own model", () => {
  const root = createProject({
    defaultProvider: "default-provider",
    defaultModel: "default-model",
    writer: {
      provider: "writer-provider",
      model: "writer-model",
      thinking: "high"
    }
  });

  try {
    const target = findTarget(listRpModelTargets(root, []), "writerAgents.inertiaCritic");
    writeRpModelSelection(root, target, { provider: "critic-provider", id: "org/critic-model" });

    assert.deepEqual(readSettings(root).writerAgents.inertiaCritic, {
      provider: "critic-provider",
      model: "org/critic-model",
      thinking: "high"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes subagent models as one canonical reference and preserves its thinking", () => {
  const root = createProject({
    defaultProvider: "default-provider",
    defaultModel: "default-model",
    rpSubagents: {
      "npc-generator": {
        provider: "legacy-provider",
        model: "legacy-model",
        thinking: "medium",
        custom: "preserve-me"
      }
    }
  });

  try {
    const target = findTarget(listRpModelTargets(root, subagents), "rpSubagents.npc-generator");
    writeRpModelSelection(root, target, { provider: "new-provider", id: "org/new-model" });

    assert.deepEqual(readSettings(root).rpSubagents["npc-generator"], {
      model: "new-provider/org/new-model",
      thinking: "medium",
      custom: "preserve-me"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("creates a missing settings file when the project config directory exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-rpconfig-missing-"));
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  try {
    const target = findTarget(listRpModelTargets(root, []), "writer");
    writeRpModelSelection(root, target, { provider: "provider", id: "model" });

    assert.equal(existsSync(join(root, ".pi", "agent", "settings.json")), true);
    assert.deepEqual(readSettings(root).writer, { provider: "provider", model: "model" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type RegisteredCommand = {
  name: string;
  handler: (args: string, ctx: any) => Promise<void> | void;
};

function registerRpConfig(
  root: string,
  options: {
    subagents?: RpSubagentModelTarget[];
    onSubagentsChanged?: (sessionId: string) => void;
  } = {}
): RegisteredCommand {
  let registered: RegisteredCommand | undefined;
  const pi = {
    on() {},
    registerTool() {},
    registerCommand(name, commandOptions) {
      registered = { name, handler: commandOptions.handler };
    },
    sendMessage() {}
  } satisfies PiLike;
  registerRpConfigCommand(pi, {
    projectRoot: root,
    getSubagents: () => options.subagents ?? [],
    onSubagentsChanged: options.onSubagentsChanged
  });
  assert.ok(registered);
  return registered;
}

function commandContext(select: (title: string, options: string[]) => Promise<string | undefined>) {
  return {
    mode: "rpc",
    sessionManager: { getSessionId: () => "session-rpconfig" },
    modelRegistry: {
      find() {},
      async getApiKeyAndHeaders() {
        return { ok: false };
      },
      refresh() {},
      getAvailable() {
        return [
          { provider: "old-provider", id: "old-model", name: "Old" },
          { provider: "new-provider", id: "org/new-model", name: "New" }
        ];
      }
    },
    ui: {
      select,
      notify() {}
    }
  };
}

test("/rpconfig selects a target first, then an authenticated model, and refreshes subagents", async () => {
  const root = createProject({
    defaultProvider: "old-provider",
    defaultModel: "old-model",
    rpSubagents: {
      "npc-generator": { model: "old-provider/old-model", thinking: "high" }
    }
  });
  const titles: string[] = [];
  const refreshes: string[] = [];
  try {
    const command = registerRpConfig(root, {
      subagents: [{ name: "npc-generator" }],
      onSubagentsChanged: (sessionId) => refreshes.push(sessionId)
    });
    assert.equal(command.name, "rpconfig");

    await command.handler(
      "",
      commandContext(async (title, options) => {
        titles.push(title);
        if (title === "选择要配置的模块") {
          return options.find((option) => option.includes("npc-generator"));
        }
        return options.find((option) => option.includes("org/new-model [new-provider]"));
      })
    );

    assert.deepEqual(titles, ["选择要配置的模块", "为「子代理：npc-generator」选择模型"]);
    assert.deepEqual(refreshes, ["session-rpconfig"]);
    assert.deepEqual(readSettings(root).rpSubagents["npc-generator"], {
      model: "new-provider/org/new-model",
      thinking: "high"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/rpconfig cancellation at either picker leaves settings untouched", async () => {
  const initial = {
    defaultProvider: "old-provider",
    defaultModel: "old-model",
    writer: { provider: "old-provider", model: "old-model", thinking: "high" }
  };

  for (const cancelAt of ["target", "model"] as const) {
    const root = createProject(initial);
    try {
      const before = readFileSync(join(root, ".pi", "agent", "settings.json"), "utf8");
      const command = registerRpConfig(root);
      let call = 0;
      await command.handler(
        "",
        commandContext(async (_title, options) => {
          call += 1;
          if (cancelAt === "target" || call === 2) {
            return undefined;
          }
          return options[0];
        })
      );
      assert.equal(readFileSync(join(root, ".pi", "agent", "settings.json"), "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("/rpconfig does not refresh subagents when changing Writer", async () => {
  const root = createProject({
    defaultProvider: "old-provider",
    defaultModel: "old-model",
    writer: { provider: "old-provider", model: "old-model", thinking: "high" }
  });
  let refreshCount = 0;
  try {
    const command = registerRpConfig(root, {
      onSubagentsChanged: () => {
        refreshCount += 1;
      }
    });
    await command.handler(
      "",
      commandContext(async (title, options) =>
        title === "选择要配置的模块"
          ? options.find((option) => option.includes("Writer（正文与重写）"))
          : options.find((option) => option.includes("org/new-model [new-provider]"))
      )
    );

    assert.equal(refreshCount, 0);
    assert.deepEqual(readSettings(root).writer, {
      provider: "new-provider",
      model: "org/new-model",
      thinking: "high"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
