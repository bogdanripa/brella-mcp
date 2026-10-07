import os from "node:os";
import path from "node:path";
import { SecretBox } from "./store/crypto.js";
import { FileStore } from "./store/file.js";
import { PgStore } from "./store/pg.js";
import type { Store } from "./store/types.js";

export interface Config {
  apiBase: string;
  authBase: string;
  socketUrl: string;
  requestsPerSecond: number;
  pageSizeDefault: number;
  timeoutMs: number;
  userAgent: string;
  debug: boolean;
}

const VERSION = "0.1.0";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiBase: (env.BRELLA_API_BASE ?? "https://api.brella.io/api").replace(/\/+$/, ""),
    authBase: (env.BRELLA_AUTH_BASE ?? env.BRELLA_API_BASE ?? "https://api.brella.io/api").replace(/\/+$/, ""),
    socketUrl: env.BRELLA_SOCKET_URL ?? "wss://api.brella.io/api/v4/socket/me",
    requestsPerSecond: Number(env.BRELLA_REQUESTS_PER_SECOND ?? 2),
    pageSizeDefault: Number(env.BRELLA_PAGE_SIZE_DEFAULT ?? 50),
    timeoutMs: 15_000,
    userAgent: `brella-mcp/${VERSION} (+https://github.com/bogdanripa/brella-mcp)`,
    debug: env.BRELLA_DEBUG === "1",
  };
}

export { VERSION };

/**
 * DATABASE_URL → Postgres store (container deployments);
 * otherwise a 0600 file under BRELLA_MCP_HOME (default ~/.brella-mcp).
 */
export function createStore(env: NodeJS.ProcessEnv = process.env): Store {
  const box = new SecretBox(env.BRELLA_SECRETS_KEY);
  if (env.DATABASE_URL) return new PgStore(env.DATABASE_URL, box);
  const home = env.BRELLA_MCP_HOME ?? path.join(os.homedir(), ".brella-mcp");
  return new FileStore(path.join(home, "store.json"), box);
}
