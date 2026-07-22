import { createOpenVikingClient, type OpenVikingClient } from "./client.ts";
import { readOpenVikingConfig } from "./config.ts";

// Best-effort OpenViking client: a missing or invalid config (no env vars, no
// settings file) must never break activation. We swallow construction errors
// and return undefined so the runtime boots without long-term memory rather
// than failing outright. Note that with no env the config still resolves to a
// usable default (local URL, empty credentials), so the common case returns a
// real client — undefined is reserved for genuinely broken config, or for an
// explicit opt-out via RP_DISABLE_OPENVIKING=1 (tests, and games that opt out
// of long-term memory entirely so its extension becomes a no-op).
export function createConfiguredOpenVikingClient(projectRoot: string): OpenVikingClient | undefined {
  if (process.env.RP_DISABLE_OPENVIKING === "1") {
    return undefined;
  }
  try {
    const config = readOpenVikingConfig(process.env, projectRoot);
    return createOpenVikingClient({ ...config, user: "rp-agent" });
  } catch {
    return undefined;
  }
}
