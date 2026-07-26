import { readOpenVikingTimeouts, type OpenVikingClientConfig } from "./config.ts";

export type OpenVikingRole = "user" | "assistant";

export type OpenVikingSearchResult = {
  uri: string;
  abstract: string;
  score: number;
};

export type OpenVikingMemoryPolicy = {
  self?: { enabled: boolean };
  peer?: { enabled: boolean };
  memory_types?: string[];
};

export type OpenVikingEnsureSessionOptions = {
  memoryPolicy?: OpenVikingMemoryPolicy;
};

export type OpenVikingCommitResult = {
  status?: string;
  taskId?: string;
};

export type OpenVikingTaskStatus = {
  /** pending | running | completed | failed (server task tracker vocabulary). */
  status?: string;
  /** Total memories the completed task wrote (summed across memory types). */
  memoriesExtracted?: number;
  /** Failure detail when the task ended in `failed`. */
  error?: string;
};

export type OpenVikingClient = {
  forUser(user: string): OpenVikingClient;
  ensureSession(sessionId: string, options?: OpenVikingEnsureSessionOptions): Promise<void>;
  addSessionMessage(sessionId: string, role: OpenVikingRole, content: string): Promise<void>;
  commitSession(sessionId: string, options: { keepRecentCount: number }): Promise<OpenVikingCommitResult>;
  getTask(taskId: string): Promise<OpenVikingTaskStatus>;
  find(query: string, targetUri: string, limit: number): Promise<OpenVikingSearchResult[]>;
  read(uri: string): Promise<string>;
};

export type OpenVikingFetch = (url: string, init?: RequestInit) => Promise<Response>;

type UnknownRecord = Record<string, unknown>;

export function createOpenVikingClient(
  config: OpenVikingClientConfig,
  fetchImpl: OpenVikingFetch = fetch
): OpenVikingClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  // Abort OV requests that hang (an unreachable host that never refuses the
  // TCP connection would otherwise stall every turn until the OS-level
  // timeout). The resulting TimeoutError rejects like any other request
  // failure, so it flows through the existing degradation path (append failure
  // → styled notice). Regular requests keep the short guard; commitSession
  // uses the longer commit budget (see config.ts for defaults + env knobs).
  const timeouts = readOpenVikingTimeouts();

  function requestHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      "content-type": "application/json",
      "X-API-Key": config.apiKey,
      "X-OpenViking-Account": config.account,
      "X-OpenViking-User": config.user,
      ...extra
    };
  }

  async function parseErrorResponse(response: Response): Promise<never> {
    let message = `OpenViking request failed: ${response.status} ${response.statusText}`;
    try {
      const payload = (await response.json()) as UnknownRecord;
      const error = payload.error as UnknownRecord | undefined;
      if (typeof error?.message === "string") {
        message = error.message;
      }
    } catch {
      // Fall back to the HTTP status line when the server does not return a JSON error envelope.
    }
    throw new Error(message);
  }

  async function parseSuccessResponse(response: Response): Promise<unknown> {
    if (response.status === 204) {
      return undefined;
    }

    const payload = (await response.json()) as UnknownRecord;
    if (payload.status === "error") {
      const error = payload.error as UnknownRecord | undefined;
      throw new Error(typeof error?.message === "string" ? error.message : "OpenViking API error");
    }

    return "result" in payload ? payload.result : payload;
  }

  async function request(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = timeouts.requestTimeoutMs
  ): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: requestHeaders(init.headers as Record<string, string> | undefined),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      await parseErrorResponse(response);
    }

    return parseSuccessResponse(response);
  }

  return {
    forUser(user) {
      return createOpenVikingClient({ ...config, user }, fetchImpl);
    },

    async ensureSession(sessionId, options = {}) {
      const encodedSessionId = encodeURIComponent(sessionId);
      const response = await fetchImpl(`${baseUrl}/api/v1/sessions/${encodedSessionId}`, {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(timeouts.requestTimeoutMs)
      });

      if (response.ok) {
        await parseSuccessResponse(response);
        return;
      }

      if (response.status !== 404) {
        await parseErrorResponse(response);
      }

      const body: UnknownRecord = {
        session_id: sessionId
      };
      if (options.memoryPolicy) {
        body.memory_policy = options.memoryPolicy;
      }

      await request("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    async addSessionMessage(sessionId, role, content) {
      await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        body: JSON.stringify({
          role,
          content
        })
      });
    },

    async commitSession(sessionId, options) {
      // Commit runs OV's server-side LLM memory extraction — a healthy but
      // slow server routinely exceeds the regular guard, so use the longer
      // commit budget instead of the per-request default.
      const body = (await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
        {
          method: "POST",
          body: JSON.stringify({
            keep_recent_count: options.keepRecentCount
          })
        },
        timeouts.commitTimeoutMs
      )) as UnknownRecord | undefined;

      return {
        status: typeof body?.status === "string" ? body.status : undefined,
        taskId: typeof body?.task_id === "string" ? body.task_id : undefined
      };
    },

    async getTask(taskId) {
      const body = (await request(`/api/v1/tasks/${encodeURIComponent(taskId)}`)) as UnknownRecord | undefined;
      const result = (typeof body?.result === "object" && body.result !== null ? body.result : {}) as UnknownRecord;
      const extracted = result.memories_extracted;
      let memoriesExtracted: number | undefined;
      if (typeof extracted === "object" && extracted !== null) {
        memoriesExtracted = Object.values(extracted as Record<string, unknown>).reduce<number>(
          (sum, count) => sum + (typeof count === "number" ? count : 0),
          0
        );
      }
      return {
        status: typeof body?.status === "string" ? body.status : undefined,
        memoriesExtracted,
        error: typeof body?.error === "string" ? body.error : undefined
      };
    },

    async find(query, targetUri, limit) {
      const body = (await request("/api/v1/search/find", {
        method: "POST",
        body: JSON.stringify({
          query,
          target_uri: targetUri,
          limit,
          context_type: "memory"
        })
      })) as UnknownRecord;
      const memories = Array.isArray(body.memories) ? body.memories : [];

      return memories.map((memory) => {
        const row = memory as UnknownRecord;
        return {
          uri: String(row.uri ?? ""),
          abstract: String(row.abstract ?? ""),
          score: Number(row.score ?? 0)
        };
      });
    },

    async read(uri) {
      const body = (await request(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`)) as UnknownRecord;
      return String(body.content ?? "");
    }
  };
}
