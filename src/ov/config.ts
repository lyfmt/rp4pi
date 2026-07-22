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
