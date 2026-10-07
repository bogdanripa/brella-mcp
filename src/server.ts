#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AccountRegistry } from "./brella/service.js";
import { createStore, loadConfig, VERSION } from "./config.js";
import { SetupFlow } from "./setup/flow.js";
import { handleSetup, safeEqual } from "./setup/web.js";
import { buildServer } from "./tools/index.js";

/**
 * Streamable HTTP entrypoint (stateless: one MCP server per request).
 *   POST /mcp                Authorization: Bearer $MCP_AUTH_TOKEN
 *   POST /mcp/$MCP_AUTH_TOKEN  for clients that cannot send headers
 *   GET  /health             liveness (no auth)
 *   /setup                   operator setup page, only if SETUP_TOKEN is set
 */

const cfg = loadConfig();
const store = createStore();
const registry = new AccountRegistry(store, cfg);
const flow = new SetupFlow(cfg, store);
const authToken = process.env.MCP_AUTH_TOKEN ?? "";
const setupToken = process.env.SETUP_TOKEN ?? "";
const port = Number(process.env.PORT ?? 3000);

if (!authToken && process.env.ALLOW_UNAUTHENTICATED !== "1") {
  console.error("MCP_AUTH_TOKEN is required (or set ALLOW_UNAUTHENTICATED=1 for local testing).");
  process.exit(1);
}
if (authToken && authToken.length < 24) {
  console.error("MCP_AUTH_TOKEN must be at least 24 characters.");
  process.exit(1);
}

function authorized(req: IncomingMessage, pathToken: string | null): boolean {
  if (!authToken) return true;
  if (pathToken !== null) return safeEqual(pathToken, authToken);
  const h = String(req.headers.authorization ?? "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1].trim(), authToken);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  const server = buildServer({ registry });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  try {
    if (url.pathname === "/health" || url.pathname === "/") {
      return json(res, 200, { ok: true, name: "brella-mcp", version: VERSION, commit: process.env.GIT_SHA ?? "unknown" });
    }
    if (url.pathname === "/setup" || url.pathname.startsWith("/setup/")) {
      if (!setupToken) return json(res, 404, { error: "setup page disabled (SETUP_TOKEN not set)" });
      return await handleSetup(req, res, flow, setupToken);
    }
    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (m) {
      if (!authorized(req, m[1] ? decodeURIComponent(m[1]) : null)) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
      return await handleMcp(req, res);
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("request failed:", (e as Error).name);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

store
  .init()
  .then(() => {
    const announce = (host: string) =>
      console.error(`brella-mcp ${VERSION} listening on ${host}:${port} (store: ${process.env.DATABASE_URL ? "postgres" : "file"}, setup page: ${setupToken ? "on" : "off"})`);
    // Dual-stack by default; fall back to IPv4 where the kernel has no IPv6.
    const host = process.env.HOST ?? "::";
    http.once("listening", () => {
      const addr = http.address();
      announce(typeof addr === "object" && addr ? addr.address : host);
    });
    http.once("error", (e: NodeJS.ErrnoException) => {
      if (host === "::" && (e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL")) http.listen(port, "0.0.0.0");
      else {
        console.error("listen failed:", e.message);
        process.exit(1);
      }
    });
    http.listen(port, host);
  })
  .catch((e) => {
    console.error("store init failed:", (e as Error).message);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    http.close();
    store.close().finally(() => process.exit(0));
  });
}
