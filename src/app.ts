import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AccountRegistry } from "./brella/service.js";
import { type Config, VERSION } from "./config.js";
import { loginRouter } from "./oauth/login.js";
import { BrellaOAuthProvider } from "./oauth/provider.js";
import { SetupFlow } from "./setup/flow.js";
import type { Store } from "./store/types.js";
import { buildServer } from "./tools/index.js";
import { homePage } from "./web/home.js";

export interface AppOptions {
  cfg: Config;
  store: Store;
  publicUrl: URL;
  /** Static admin bearer token (all accounts). Empty disables it. */
  staticToken?: string;
  /** Test seam: replaces fetch for Brella data calls. */
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the Brella auth calls used by /login. */
  flow?: SetupFlow;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Authed extends Request {
  boundEmail?: string;
}

export function createApp(opts: AppOptions): express.Express {
  const { cfg, store, publicUrl } = opts;
  const staticToken = opts.staticToken ?? "";
  const registry = new AccountRegistry(store, cfg, opts.fetchImpl);
  const flow = opts.flow ?? new SetupFlow(cfg, store);
  const provider = new BrellaOAuthProvider(store);
  const mcpUrl = new URL("/mcp", publicUrl);
  const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", publicUrl).toString();

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const home = homePage(publicUrl);
  app.get("/", (_req, res) => {
    res.set({ "cache-control": "public, max-age=300", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }).type("html").send(home);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "brella-mcp", version: VERSION, commit: process.env.GIT_SHA ?? "unknown" });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: "Brella",
      scopesSupported: ["brella"],
    }),
  );
  // Some clients look for the resource metadata at the root as well.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: mcpUrl.toString(), authorization_servers: [publicUrl.toString()], scopes_supported: ["brella"], resource_name: "Brella" });
  });
  app.use(loginRouter(store, flow, provider, cfg));

  async function authenticate(req: Authed, res: Response, next: NextFunction): Promise<void> {
    const fromPath = typeof req.params.token === "string" ? req.params.token : null;
    const header = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;
    const token = fromPath ?? header;
    if (token && staticToken && safeEqual(token, staticToken)) return next();
    if (token && !fromPath) {
      try {
        const info = await provider.verifyAccessToken(token);
        req.boundEmail = String(info.extra?.email ?? "");
        if (req.boundEmail) return next();
      } catch {
        /* fall through to 401 */
      }
    }
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`)
      .json({ error: "invalid_token", error_description: "Sign in to Brella to use this server" });
  }

  async function handleMcp(req: Authed, res: Response): Promise<void> {
    const server = buildServer({ registry, boundEmail: req.boundEmail });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  const json = express.json({ limit: "1mb" });
  const run = (req: Request, res: Response) => void handleMcp(req as Authed, res).catch(() => res.headersSent || res.status(500).end());
  app.post("/mcp", json, authenticate, run);
  app.post("/mcp/:token", json, authenticate, run);
  app.all(["/mcp", "/mcp/:token"], (_req, res) => {
    res.status(405).set("Allow", "POST").end();
  });
  return app;
}
