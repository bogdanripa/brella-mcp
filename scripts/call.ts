/**
 * Call one MCP tool locally against the configured store (file store by default).
 *   npx tsx scripts/call.ts brella_list_my_events '{"status":"ongoing"}'
 *   npx tsx scripts/call.ts --list
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountRegistry } from "../src/brella/service.js";
import { createStore, loadConfig } from "../src/config.js";
import { buildServer } from "../src/tools/index.js";

const [name, rawArgs] = process.argv.slice(2);
const store = createStore();
await store.init();
const server = buildServer({ registry: new AccountRegistry(store, loadConfig()) });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "cli", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);
if (!name || name === "--list") {
  for (const t of (await client.listTools()).tools) console.log(t.name);
} else {
  const res: any = await client.callTool({ name, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
  console.log(res.content?.[0]?.text ?? JSON.stringify(res));
  if (res.isError) process.exitCode = 1;
}
await client.close();
await store.close();
