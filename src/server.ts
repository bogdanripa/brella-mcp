#!/usr/bin/env node
import { createApp } from "./app.js";
import { createStore, loadConfig, VERSION } from "./config.js";

/**
 * HTTP entrypoint.
 *   POST /mcp            Streamable HTTP (stateless). Auth: OAuth access token (bound to one
 *                        Brella account) or the static MCP_AUTH_TOKEN (all accounts).
 *   OAuth 2.1 AS         /.well-known/*, /register, /authorize, /token, /revoke
 *   GET  /login          Brella email-code sign-in page that completes /authorize
 *   GET  /health
 */

const cfg = loadConfig();
const store = createStore();
const port = Number(process.env.PORT ?? 3000);
const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://localhost:${port}`);
const staticToken = process.env.MCP_AUTH_TOKEN ?? "";
const app = createApp({ cfg, store, publicUrl, staticToken });

store
  .init()
  .then(() => {
    const host = process.env.HOST ?? "::";
    const srv = app.listen(port, host);
    srv.once("listening", () => {
      const a = srv.address();
      console.error(
        `brella-mcp ${VERSION} on ${typeof a === "object" && a ? a.address : host}:${port} · public ${publicUrl.origin} · store ${process.env.DATABASE_URL ? "postgres" : "file"} · static token ${staticToken ? "on" : "off"}`,
      );
    });
    srv.once("error", (e: NodeJS.ErrnoException) => {
      if (host === "::" && (e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL")) app.listen(port, "0.0.0.0", () => console.error(`brella-mcp on 0.0.0.0:${port}`));
      else {
        console.error("listen failed:", e.message);
        process.exit(1);
      }
    });
  })
  .catch((e) => {
    console.error("store init failed:", (e as Error).message);
    process.exit(1);
  });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.close().finally(() => process.exit(0));
  });
}
