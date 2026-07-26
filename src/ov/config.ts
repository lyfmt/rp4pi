import { readFileSync } from "node:fs";
import { join } from "node:path";

export type OpenVikingConfig = {
  baseUrl: string;
  apiKey: string;
  account: string;
};

export type OpenVikingClientConfig = OpenVikingConfig & {
  user: string;
};

export type OpenVikingEnv = Partial<Record<"OPENVIKING_URL" | "OPENVIKING_API_KEY" | "OPENVIKING_ACCOUNT", string>>;

const DEFAULT_OPENVIKING_URL = "http://127.0.0.1:1933";

export function readOpenVikingConfig(env: OpenVikingEnv = process.env, projectRoot = process.cwd()): OpenVikingConfig {
  const settings = readOpenVikingSettings(projectRoot);
  const baseUrl = (env.OPENVIKING_URL ?? settings.url ?? DEFAULT_OPENVIKING_URL).replace(/\/+$/, "");
  const apiKey = env.OPENVIKING_API_KEY ?? settings.apiKey ?? "";
  const account = env.OPENVIKING_ACCOUNT ?? settings.account ?? "";

  return { baseUrl, apiKey, account };
}

// OV request timeouts. Regular API calls keep a short guard: an unreachable
// host that never refuses the TCP connection would otherwise stall every turn.
// commitSession triggers server-side LLM memory extraction, which a healthy
// but slow OV can easily exceed 10s on — cutting it off would surface an error
// every turn and silently stall long-term memory, so commit gets its own
// longer default. Both are env-overridable; invalid values fall back to the
// defaults rather than handing AbortSignal.timeout a NaN/0/negative budget.
export const DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_OPENVIKING_COMMIT_TIMEOUT_MS = 60_000;
// Commit only ENQUEUES server-side memory extraction (it returns a task_id);
// the extraction itself is a background LLM task that routinely takes minutes
// (upstream 503 retries included). The extract watch is how long the UI keeps
// following that task before declaring the outcome unknown, and the poll
// interval is how often it asks — both far coarser than the request guards.
export const DEFAULT_OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS = 600_000;
export const DEFAULT_OPENVIKING_EXTRACT_POLL_INTERVAL_MS = 3_000;

export type OpenVikingTimeoutEnv = Partial<
  Record<
    | "OPENVIKING_REQUEST_TIMEOUT_MS"
    | "OPENVIKING_COMMIT_TIMEOUT_MS"
    | "OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS"
    | "OPENVIKING_EXTRACT_POLL_INTERVAL_MS",
    string
  >
>;

export type OpenVikingTimeouts = {
  requestTimeoutMs: number;
  commitTimeoutMs: number;
  extractWatchTimeoutMs: number;
  extractPollIntervalMs: number;
};

export function readOpenVikingTimeouts(env: OpenVikingTimeoutEnv = process.env): OpenVikingTimeouts {
  return {
    requestTimeoutMs: parseTimeoutMs(env.OPENVIKING_REQUEST_TIMEOUT_MS, DEFAULT_OPENVIKING_REQUEST_TIMEOUT_MS),
    commitTimeoutMs: parseTimeoutMs(env.OPENVIKING_COMMIT_TIMEOUT_MS, DEFAULT_OPENVIKING_COMMIT_TIMEOUT_MS),
    extractWatchTimeoutMs: parseTimeoutMs(
      env.OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS,
      DEFAULT_OPENVIKING_EXTRACT_WATCH_TIMEOUT_MS
    ),
    extractPollIntervalMs: parseTimeoutMs(
      env.OPENVIKING_EXTRACT_POLL_INTERVAL_MS,
      DEFAULT_OPENVIKING_EXTRACT_POLL_INTERVAL_MS
    )
  };
}

function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  // Floor BEFORE validating: "0.5" floors to 0, which must fall back rather
  // than hand a zero budget to AbortSignal.timeout or a poll loop.
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type OpenVikingSettings = {
  url?: string;
  apiKey?: string;
  account?: string;
};

function readOpenVikingSettings(projectRoot: string): OpenVikingSettings {
  try {
    const parsed = JSON.parse(readFileSync(join(projectRoot, ".pi", "agent", "settings.json"), "utf8")) as {
      openViking?: {
        url?: unknown;
        apiKey?: unknown;
        account?: unknown;
      };
    };
    return {
      url: typeof parsed.openViking?.url === "string" ? parsed.openViking.url : undefined,
      apiKey: typeof parsed.openViking?.apiKey === "string" ? parsed.openViking.apiKey : undefined,
      account: typeof parsed.openViking?.account === "string" ? parsed.openViking.account : undefined
    };
  } catch {
    return {};
  }
}
