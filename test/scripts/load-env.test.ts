import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const loadEnvScript = new URL("../../scripts/load-env.sh", import.meta.url).pathname;
const startScript = new URL("../../start.sh", import.meta.url).pathname;
const settingsTemplate = new URL("../../.pi/agent/settings.example.json", import.meta.url).pathname;

test("load-env loads local env values without overriding existing exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-env-"));
  const envPath = join(dir, ".env");
  try {
    writeFileSync(
      envPath,
      [
        "OPENVIKING_URL=http://127.0.0.1:1933",
        "OPENVIKING_API_KEY=dev",
        "OPENVIKING_ACCOUNT=rp-agent"
      ].join("\n")
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "export OPENVIKING_URL=preexisting",
          "RP_AGENT_ENV_FILE=\"$1\"",
          "source \"$2\"",
          "printf '%s\\n%s\\n%s\\n' \"$OPENVIKING_URL\" \"$OPENVIKING_API_KEY\" \"$OPENVIKING_ACCOUNT\""
        ].join("; "),
        "bash",
        envPath,
        loadEnvScript
      ],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["preexisting", "dev", "rp-agent"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load-env loads the RP_DISABLE_OPENVIKING switch without overriding existing exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-load-env-"));
  const envPath = join(dir, ".env");
  try {
    writeFileSync(envPath, "RP_DISABLE_OPENVIKING=1\n");

    // Fresh shell: the .env value is exported for every entrypoint that
    // sources load-env.sh (start.sh, smoke-*.sh).
    const loaded = spawnSync(
      "bash",
      [
        "-c",
        [
          "unset RP_DISABLE_OPENVIKING",
          "RP_AGENT_ENV_FILE=\"$1\"",
          "source \"$2\"",
          "printf '%s\\n' \"$RP_DISABLE_OPENVIKING\""
        ].join("; "),
        "bash",
        envPath,
        loadEnvScript
      ],
      { encoding: "utf8" }
    );
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout.trim(), "1");

    // Existing exports keep priority over .env (the semantics smoke scripts
    // rely on to force-enable the OpenViking path).
    const preexisting = spawnSync(
      "bash",
      [
        "-c",
        [
          "export RP_DISABLE_OPENVIKING=0",
          "RP_AGENT_ENV_FILE=\"$1\"",
          "source \"$2\"",
          "printf '%s\\n' \"$RP_DISABLE_OPENVIKING\""
        ].join("; "),
        "bash",
        envPath,
        loadEnvScript
      ],
      { encoding: "utf8" }
    );
    assert.equal(preexisting.status, 0, preexisting.stderr);
    assert.equal(preexisting.stdout.trim(), "0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start.sh creates default writer and OpenViking settings for a new project checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-start-settings-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
    copyFileSync(startScript, join(dir, "start.sh"));
    copyFileSync(loadEnvScript, join(dir, "scripts", "load-env.sh"));
    copyFileSync(settingsTemplate, join(dir, ".pi", "agent", "settings.example.json"));
    chmodSync(join(dir, "start.sh"), 0o755);
    writeFileSync(join(dir, "bin", "pi"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(dir, "bin", "pi"), 0o755);

    const result = spawnSync("bash", ["./start.sh"], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".pi", "agent", "settings.json"), "utf8")), {
      theme: "dark",
      defaultProvider: "opencode-go",
      defaultModel: "deepseek-v4-pro",
      writer: {
        provider: "opencode-go",
        model: "deepseek-v4-pro",
        thinking: "high"
      },
      writerAgents: {
        styleEnhancer: {
          provider: "opencode-go",
          model: "deepseek-v4-pro",
          thinking: "medium"
        },
        inertiaCritic: {
          provider: "opencode-go",
          model: "deepseek-v4-pro",
          thinking: "low"
        },
        clicheCritic: {
          provider: "opencode-go",
          model: "deepseek-v4-pro",
          thinking: "low"
        }
      },
      rpSubagents: {
        "npc-generator": {
          provider: "opencode-go",
          model: "deepseek-v4-pro",
          thinking: "high"
        },
        "wounded-messenger": {
          provider: "opencode-go",
          model: "deepseek-v4-pro"
        },
        "role-forger": {
          provider: "opencode-go",
          model: "deepseek-v4-pro",
          thinking: "high"
        }
      },
      openViking: {
        url: "http://127.0.0.1:1933",
        apiKey: "",
        account: ""
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
