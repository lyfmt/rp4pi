import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const clientModule = await import(pathToFileURL(new URL("../../src/ov/client.ts", import.meta.url).pathname).href);
const configModule = await import(pathToFileURL(new URL("../../src/ov/config.ts", import.meta.url).pathname).href);
const saveRepository = await import(
  pathToFileURL(new URL("../../src/state/save-repository.ts", import.meta.url).pathname).href
);
const sqlite = await import(pathToFileURL(new URL("../../src/state/sqlite.ts", import.meta.url).pathname).href);
const sessionBindingModule = await import(
  pathToFileURL(new URL("../../src/ov/session-binding.ts", import.meta.url).pathname).href
);

const createOpenVikingClient =
  clientModule.createOpenVikingClient as typeof import("../../src/ov/client.js").createOpenVikingClient;
const readOpenVikingConfig =
  configModule.readOpenVikingConfig as typeof import("../../src/ov/config.js").readOpenVikingConfig;
const readOpenVikingTimeouts =
  configModule.readOpenVikingTimeouts as typeof import("../../src/ov/config.js").readOpenVikingTimeouts;
const createSave = saveRepository.createSave as typeof import("../../src/state/save-repository.js").createSave;
const initializeSchema = sqlite.initializeSchema as typeof import("../../src/state/sqlite.js").initializeSchema;
const openRpDatabase = sqlite.openRpDatabase as typeof import("../../src/state/sqlite.js").openRpDatabase;
const getOrCreateOvSessionForSave =
  sessionBindingModule.getOrCreateOvSessionForSave as typeof import("../../src/ov/session-binding.js").getOrCreateOvSessionForSave;

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("readOpenVikingConfig reads OpenViking environment variables", () => {
  assert.deepEqual(
    readOpenVikingConfig({
      OPENVIKING_URL: "https://ov.example.test/",
      OPENVIKING_API_KEY: "secret",
      OPENVIKING_ACCOUNT: "acct"
    }),
    {
      baseUrl: "https://ov.example.test",
      apiKey: "secret",
      account: "acct"
    }
  );
});

test("readOpenVikingConfig falls back to .pi/agent/settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-ov-config-"));
  try {
    mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "agent", "settings.json"),
      JSON.stringify({
        openViking: {
          url: "http://127.0.0.1:1933/",
          apiKey: "dev-key",
          account: "dev-account"
        }
      })
    );

    assert.deepEqual(readOpenVikingConfig({}, dir), {
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "dev-key",
      account: "dev-account"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readOpenVikingConfig uses local defaults when env and settings are absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-ov-config-defaults-"));
  try {
    assert.deepEqual(readOpenVikingConfig({}, dir), {
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "",
      account: ""
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenViking client sends auth and scope headers", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: "session-1" });
    }
  );

  await client.ensureSession("session-1");

  assert.equal(calls[0]?.url, "https://ov.example.test/api/v1/sessions/session-1");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["X-API-Key"], "secret");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["X-OpenViking-Account"], "acct");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)["X-OpenViking-User"], "save-user");
});

test("ensureSession creates the session with a memory policy when OpenViking reports it missing", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse({ status: "error", error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
      }
      return jsonResponse({ status: "ok", result: { session_id: "session-1" } });
    }
  );

  await client.ensureSession("session-1", {
    memoryPolicy: {
      self: { enabled: true },
      peer: { enabled: false },
      memory_types: ["characters", "story_events"]
    }
  });

  assert.equal(calls[0]?.url, "https://ov.example.test/api/v1/sessions/session-1");
  assert.equal(calls[1]?.url, "https://ov.example.test/api/v1/sessions");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    session_id: "session-1",
    memory_policy: {
      self: { enabled: true },
      peer: { enabled: false },
      memory_types: ["characters", "story_events"]
    }
  });
});

test("addSessionMessage posts to the session messages path", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    }
  );

  await client.addSessionMessage("session-1", "assistant", "The courier arrives.");

  assert.equal(calls[0]?.url, "https://ov.example.test/api/v1/sessions/session-1/messages");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    role: "assistant",
    content: "The courier arrives."
  });
});

test("commitSession sends only supported commit fields", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ status: "ok", result: { status: "accepted", task_id: "task-1" } });
    }
  );

  const result = await client.commitSession("session-1", { keepRecentCount: 0 });

  assert.equal(calls[0]?.url, "https://ov.example.test/api/v1/sessions/session-1/commit");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    keep_recent_count: 0
  });
  assert.deepEqual(result, { status: "accepted", taskId: "task-1" });
});

test("getTask parses the task tracker snapshot", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        status: "ok",
        result: {
          task_id: "task-1",
          task_type: "session_commit",
          status: "completed",
          stage: "completed",
          result: { memories_extracted: { memory_write: 2, skill_write: 1 } }
        }
      });
    }
  );

  const task = await client.getTask("task-1");

  assert.equal(calls[0]?.url, "https://ov.example.test/api/v1/tasks/task-1");
  assert.deepEqual(task, { status: "completed", memoriesExtracted: 3, error: undefined });
});

test("getTask surfaces failed tasks and tolerates missing result payloads", async () => {
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async () =>
      jsonResponse({
        status: "ok",
        result: { task_id: "task-1", status: "failed", error: "extraction blew up" }
      })
  );

  const task = await client.getTask("task-1");

  assert.deepEqual(task, { status: "failed", memoriesExtracted: undefined, error: "extraction blew up" });
});

test("find and read parse OpenViking responses", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/search/find")) {
        return jsonResponse({
          status: "ok",
          result: {
            memories: [{ uri: "viking://user/save-1/memories/story.md", abstract: "Story event", score: 0.75 }],
            resources: [],
            skills: []
          }
        });
      }
      return jsonResponse({ status: "ok", result: { content: "# Ari\n" } });
    }
  );

  const results = await client.find("courier", "viking://user/save-1/memories", 5);
  const markdown = await client.read("viking://user/save-1/memories/characters/Ari.md");

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    query: "courier",
    target_uri: "viking://user/save-1/memories",
    limit: 5,
    context_type: "memory"
  });
  assert.equal(
    calls[1]?.url,
    "https://ov.example.test/api/v1/content/read?uri=viking%3A%2F%2Fuser%2Fsave-1%2Fmemories%2Fcharacters%2FAri.md"
  );
  assert.deepEqual(results, [{ uri: "viking://user/save-1/memories/story.md", abstract: "Story event", score: 0.75 }]);
  assert.equal(markdown, "# Ari\n");
});

test("OpenViking client can derive a save-scoped user client", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "default-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ status: "ok", result: { id: "session-1" } });
    }
  );

  await client.forUser("save-123").ensureSession("session-1");

  assert.equal((calls[0]?.init?.headers as Record<string, string>)["X-OpenViking-User"], "save-123");
});

test("OpenViking client passes a timeout signal to every fetch call", async () => {
  const calls: FetchCall[] = [];
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse({ status: "error", error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
      }
      return jsonResponse({ status: "ok", result: { session_id: "session-1" } });
    }
  );

  // Covers both fetch paths: the raw ensureSession GET plus the shared
  // request() helper (session create after 404, then a message append).
  await client.ensureSession("session-1");
  await client.addSessionMessage("session-1", "user", "hello");

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.ok(call.init?.signal instanceof AbortSignal, `${call.url} is missing a timeout AbortSignal`);
    assert.equal(call.init?.signal?.aborted, false);
  }
});

test("readOpenVikingTimeouts defaults to 10s requests and a longer 60s commit", () => {
  assert.deepEqual(readOpenVikingTimeouts({}), {
    requestTimeoutMs: 10_000,
    commitTimeoutMs: 60_000,
    extractWatchTimeoutMs: 600_000,
    extractPollIntervalMs: 3_000
  });
});

test("readOpenVikingTimeouts honors env overrides and falls back on invalid values", () => {
  assert.deepEqual(
    readOpenVikingTimeouts({
      OPENVIKING_REQUEST_TIMEOUT_MS: "2500",
      OPENVIKING_COMMIT_TIMEOUT_MS: "120000",
      OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS: "30000",
      OPENVIKING_EXTRACT_POLL_INTERVAL_MS: "500"
    }),
    { requestTimeoutMs: 2500, commitTimeoutMs: 120_000, extractWatchTimeoutMs: 30_000, extractPollIntervalMs: 500 }
  );
  assert.deepEqual(
    readOpenVikingTimeouts({
      OPENVIKING_REQUEST_TIMEOUT_MS: "not-a-number",
      OPENVIKING_COMMIT_TIMEOUT_MS: "-5",
      OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS: "0",
      OPENVIKING_EXTRACT_POLL_INTERVAL_MS: ""
    }),
    { requestTimeoutMs: 10_000, commitTimeoutMs: 60_000, extractWatchTimeoutMs: 600_000, extractPollIntervalMs: 3_000 }
  );
});

// A fetch that never resolves on its own and only rejects when the timeout
// signal fires — lets the tests observe which timeout budget a call received.
const hangingFetch: import("../../src/ov/client.js").OpenVikingFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject((init.signal as AbortSignal).reason ?? new Error("aborted"));
    });
  });

function withTimeoutEnv(requestMs: string, commitMs: string, run: () => Promise<void>): Promise<void> {
  const previousRequest = process.env.OPENVIKING_REQUEST_TIMEOUT_MS;
  const previousCommit = process.env.OPENVIKING_COMMIT_TIMEOUT_MS;
  process.env.OPENVIKING_REQUEST_TIMEOUT_MS = requestMs;
  process.env.OPENVIKING_COMMIT_TIMEOUT_MS = commitMs;
  return run().finally(() => {
    restoreEnv("OPENVIKING_REQUEST_TIMEOUT_MS", previousRequest);
    restoreEnv("OPENVIKING_COMMIT_TIMEOUT_MS", previousCommit);
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const isTimeoutRejection = (error: unknown) => (error as { name?: string }).name === "TimeoutError";

test("commitSession uses the commit timeout budget, not the request one", async () => {
  // Tiny commit budget vs. a huge request budget: the call only aborts quickly
  // if commitSession really wired timeouts.commitTimeoutMs into its signal.
  await withTimeoutEnv("60000", "40", async () => {
    const client = createOpenVikingClient(
      { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
      hangingFetch
    );

    const started = Date.now();
    await assert.rejects(() => client.commitSession("session-1", { keepRecentCount: 0 }), isTimeoutRejection);
    assert.ok(Date.now() - started < 5000, "commit did not abort within the commit budget");
  });
});

test("regular requests honor the request timeout env override", async () => {
  await withTimeoutEnv("40", "60000", async () => {
    const client = createOpenVikingClient(
      { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
      hangingFetch
    );

    const started = Date.now();
    await assert.rejects(() => client.addSessionMessage("session-1", "user", "hello"), isTimeoutRejection);
    assert.ok(Date.now() - started < 5000, "message append did not abort within the request budget");
  });
});

test("OpenViking client throws API envelope errors", async () => {
  const client = createOpenVikingClient(
    { baseUrl: "https://ov.example.test", apiKey: "secret", account: "acct", user: "save-user" },
    async () => jsonResponse({ status: "error", error: { message: "bad request" } })
  );

  await assert.rejects(() => client.ensureSession("session-1"), /bad request/);
});

test("getOrCreateOvSessionForSave creates and reuses a save binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-ov-binding-"));
  const db = openRpDatabase(join(dir, "state.sqlite"));
  try {
    initializeSchema(db);
    const save = createSave(db);

    const first = getOrCreateOvSessionForSave(db, save.id);
    const second = getOrCreateOvSessionForSave(db, save.id);

    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(second, first);
    const rows = db.prepare("SELECT save_id, ov_session_id FROM ov_session_bindings").all() as Array<{
      save_id: string;
      ov_session_id: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.save_id, save.id);
    assert.equal(rows[0]?.ov_session_id, first);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
