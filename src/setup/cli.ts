#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createStore, loadConfig } from "../config.js";
import { SetupError } from "../errors.js";
import { manualInstructions, MAX_CODE_TRIES, SetupFlow } from "./flow.js";

/**
 * Local setup surface (spec §4.1). The code is read from the terminal with
 * echo disabled — never from argv, env or an MCP tool.
 *
 *   brella-mcp-setup add <email> [--alias work] [--default] [--manual]
 *   brella-mcp-setup list
 *   brella-mcp-setup default <email>
 *   brella-mcp-setup remove <email>
 *
 * Two-step, non-interactive variant (e.g. for testing from a chat session):
 *   brella-mcp-setup request <email>
 *   brella-mcp-setup verify <email> <code> [--alias work] [--default]
 */

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        out.output.write(s);
        asked = true;
      } else if (s.includes("\n")) out.output.write("\n");
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function flag(args: string[], name: string): string | boolean | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  const store = createStore();
  await store.init();
  const flow = new SetupFlow(cfg, store);
  try {
    switch (cmd) {
      case "add": {
        const email = rest.find((x) => !x.startsWith("--"));
        if (!email) throw new SetupError("INVALID_EMAIL", "usage: add <email> [--alias name] [--default] [--manual]");
        const alias = flag(rest, "alias");
        const start = await flow.start(email, {
          alias: typeof alias === "string" ? alias : undefined,
          makeDefault: !!flag(rest, "default"),
          skipRequest: !!flag(rest, "manual"),
        });
        console.log(start.instructions);
        for (let i = 0; i < MAX_CODE_TRIES; i++) {
          const code = await promptHidden("Sign-in code: ");
          if (!code) continue;
          try {
            const ready = await flow.verify(start.attempt_id, code);
            console.log(`\n✔ ${ready.email}${ready.alias ? ` (${ready.alias})` : ""} is ready${ready.is_default ? " [default]" : ""}.`);
            if (ready.events.length) {
              console.log("Events:");
              for (const e of ready.events) console.log(`  - ${e.slug}  ${e.name ?? ""}  (${e.status})`);
            } else console.log("No events visible on this account yet.");
            return 0;
          } catch (e) {
            if (e instanceof SetupError && e.code === "INVALID_CODE") {
              console.error(`✘ ${e.message}`);
              continue;
            }
            throw e;
          }
        }
        throw new SetupError("TOO_MANY_ATTEMPTS", "Too many wrong codes; run add again for a fresh code");
      }
      case "request": {
        const email = rest[0];
        if (!email) throw new SetupError("INVALID_EMAIL", "usage: request <email>");
        const r = await flow.api.requestCode(cfg, email.trim().toLowerCase());
        console.log(r.sent ? `Brella accepted the request; a code is on its way to ${email}.` : `Brella refused (${r.status}, ${r.reason}): ${r.detail ?? ""}${r.reason === "captcha_required" ? `\n${manualInstructions(email)}` : ""}`);
        return r.sent ? 0 : 2;
      }
      case "verify": {
        const [email, code] = rest;
        if (!email || !code) throw new SetupError("INVALID_CODE", "usage: verify <email> <code>");
        const alias = flag(rest, "alias");
        const v = await flow.api.verifyCode(cfg, email.trim().toLowerCase(), code);
        const ready = await flow.completeSignIn(
          { email: email.trim().toLowerCase(), alias: typeof alias === "string" ? alias : undefined, makeDefault: !!flag(rest, "default") },
          v.session,
          v.user,
        );
        console.log(`✔ ${ready.email} ready. Events: ${ready.events.map((e) => `${e.slug} (${e.status})`).join(", ") || "none"}`);
        return 0;
      }
      case "list": {
        for (const a of await flow.status()) {
          const state = a.session_valid === true ? "ready" : a.session_valid === false ? "SETUP REQUIRED" : "unknown (Brella unreachable)";
          console.log(`${a.is_default ? "*" : " "} ${a.email}${a.alias ? ` (${a.alias})` : ""}  ${state}`);
        }
        return 0;
      }
      case "default": {
        const email = rest[0];
        if (!email) throw new SetupError("INVALID_EMAIL", "usage: default <email>");
        await store.setDefault(email);
        console.log(`Default account is now ${email}`);
        return 0;
      }
      case "remove": {
        const email = rest[0];
        if (!email) throw new SetupError("INVALID_EMAIL", "usage: remove <email>");
        const r = await flow.remove(email);
        console.log(`Upstream sign-out: ${r.upstream_sign_out}; local account and session removed: ${r.local_removed}`);
        return 0;
      }
      default:
        console.log("usage: brella-mcp-setup <add|request|verify|list|default|remove> ...");
        return cmd ? 1 : 0;
    }
  } catch (e) {
    const code = e instanceof SetupError ? e.code : "ERROR";
    console.error(`✘ [${code}] ${(e as Error).message}`);
    return 1;
  } finally {
    await store.close();
  }
}

main().then((c) => process.exit(c));
