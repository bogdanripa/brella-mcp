#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AccountRegistry } from "./brella/service.js";
import { createStore, loadConfig } from "./config.js";
import { buildServer } from "./tools/index.js";

/** stdio entrypoint for local MCP clients. Run `brella-mcp-setup add <email>` first. */
async function main(): Promise<void> {
  const store = createStore();
  await store.init();
  const server = buildServer({ registry: new AccountRegistry(store, loadConfig()) });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("brella-mcp failed to start:", (e as Error).message);
  process.exit(1);
});
