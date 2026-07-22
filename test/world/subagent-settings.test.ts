import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSubagentSettings } from "../../src/world/subagent-settings.ts";

function withSettings(body: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "rp-subagent-settings-"));
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  writeFileSync(join(root, ".pi", "agent", "settings.json"), JSON.stringify(body));
  return root;
}

test("reads per-subagent provider/model/thinking from .pi/agent/settings.json", () => {
  const root = withSettings({
    rpSubagents: {
      "npc-generator": {
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        thinking: "high"
      },
      "wounded-messenger": {
        model: "opencode-go/deepseek-v4-pro"
      },
      "role-forger": {
        thinking: "medium"
      }
    }
  });
  try {
    assert.deepEqual(readSubagentSettings(root), {
      "npc-generator": {
        model: "opencode-go/deepseek-v4-pro",
        thinking: "high"
      },
      "wounded-messenger": {
        model: "opencode-go/deepseek-v4-pro"
      },
      "role-forger": {
        thinking: "medium"
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves Pi native subagents settings while reading rpSubagents", () => {
  const root = withSettings({
    subagents: {
      disableBuiltins: true
    },
    rpSubagents: {
      "npc-generator": {
        provider: "opencode-go",
        model: "deepseek-v4-pro"
      }
    }
  });
  try {
    assert.deepEqual(readSubagentSettings(root), {
      "npc-generator": {
        model: "opencode-go/deepseek-v4-pro"
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy object entries under subagents are still accepted", () => {
  const root = withSettings({
    subagents: {
      disableBuiltins: true,
      "npc-generator": {
        provider: "opencode-go",
        model: "deepseek-v4-pro"
      }
    }
  });
  try {
    assert.deepEqual(readSubagentSettings(root), {
      "npc-generator": {
        model: "opencode-go/deepseek-v4-pro"
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing settings file means no subagent overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-subagent-settings-missing-"));
  try {
    assert.deepEqual(readSubagentSettings(root), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent settings reject a bare model without provider", () => {
  const root = withSettings({
    rpSubagents: {
      "npc-generator": {
        model: "deepseek-v4-pro"
      }
    }
  });
  try {
    assert.throws(() => readSubagentSettings(root), /rpSubagents\.npc-generator\.model/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
