import { resolve } from "node:path";

export type RuntimeConfig = {
  projectRoot: string;
  sqlitePath: string;
  demoMode: boolean;
};

export function loadRuntimeConfig(projectRoot = process.cwd()): RuntimeConfig {
  return {
    projectRoot,
    sqlitePath: process.env.RP_SQLITE_PATH ?? resolve(projectRoot, "data", "rp.sqlite"),
    demoMode: process.env.RP_DEMO_MODE !== "0"
  };
}
