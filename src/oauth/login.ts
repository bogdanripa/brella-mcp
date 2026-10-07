import express, { type Router } from "express";
import type { Config } from "../config.js";
import { SetupError } from "../errors.js";
import { manualInstructions, MAX_CODE_TRIES, type SetupFlow } from "../setup/flow.js";
import type { Store } from "../store/types.js";
import { type BrellaOAuthProvider, PENDING_TTL, type PendingAuth } from "./provider.js";

/**
 * /login — the page an MCP client sends the user to. Two steps:
 *   1. email → we ask Brella to email a sign-in code
 *   2. code  → Brella session stored, OAuth code issued, browser redirected back to the client
 * All state is in the store (keyed by the pending request id), so it is stateless per instance.
 */
export function loginRouter(store: Store, flow: SetupFlow, provider: BrellaOAuthProvider, cfg: Config): Router {
  const r = express.Router();
  r.use("/login", express.json({ limit: "8kb" }));

  const load = async (id: unknown): Promise<PendingAuth | null> => (typeof id === "string" && id ? store.kvGet<PendingAuth>("pending", id) : null);

  r.get("/login", async (req, res) => {
    const p = await load(req.query.req);
    res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    if (!p) return res.status(400).type("html").send(page("This sign-in link expired. Go back to your app and connect again.", null, null));
    res.type("html").send(page(null, p.client_name ?? null, p.email ?? null));
  });

  r.post("/login/start", async (req, res) => {
    const id = req.body?.req;
    const p = await load(id);
    if (!p) return res.status(400).json({ error: { code: "SETUP_ATTEMPT_EXPIRED", message: "This sign-in request expired. Start again from your app." } });
    try {
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      const result = await flow.api.requestCode(cfg, email);
      await store.kvPut("pending", id, { ...p, email, tries: 0, code_sent: result.sent } satisfies PendingAuth, PENDING_TTL);
      res.json({ code_sent: result.sent, instructions: result.sent ? `We asked Brella to email a sign-in code to ${email}.` : manualInstructions(email) });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post("/login/verify", async (req, res) => {
    const id = req.body?.req;
    const p = await load(id);
    if (!p || !p.email) return res.status(400).json({ error: { code: "SETUP_ATTEMPT_NOT_FOUND", message: "Enter your email first." } });
    if (p.tries >= MAX_CODE_TRIES) {
      await store.kvDelete("pending", id);
      return res.status(400).json({ error: { code: "TOO_MANY_ATTEMPTS", message: "Too many wrong codes. Start again from your app." } });
    }
    await store.kvPut("pending", id, { ...p, tries: p.tries + 1 }, PENDING_TTL);
    try {
      const verified = await flow.api.verifyCode(cfg, p.email, String(req.body?.code ?? ""));
      await flow.completeSignIn({ email: p.email, makeDefault: false }, verified.session, verified.user);
      res.json({ redirect: await provider.completeAuthorization(id, p, p.email) });
    } catch (e) {
      sendError(res, e);
    }
  });

  return r;
}

function sendError(res: express.Response, e: unknown): void {
  if (e instanceof SetupError) {
    res.status(e.code === "RATE_LIMITED" ? 429 : 400).json({ error: { code: e.code, message: e.message } });
  } else {
    res.status(500).json({ error: { code: "ERROR", message: "Something went wrong talking to Brella." } });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(fatal: string | null, clientName: string | null, email: string | null): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Brella</title>
<style>
:root{--bg:#f6f6f8;--fg:#18181b;--muted:#6b6b71;--card:#fff;--line:#e4e4e7;--acc:#4b3fd6;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececef;--muted:#a1a1aa;--card:#1a1a1d;--line:#2e2e33;--acc:#8b80ff;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:420px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:21px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-size:14px;margin:0 0 6px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--fg);font:inherit}
input.code{letter-spacing:.3em;font-size:22px;text-align:center}
button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.6;cursor:default}.link{background:none;color:var(--acc);width:auto;padding:0;margin-top:12px;font-weight:400}
.msg{margin-top:12px;font-size:14px}.bad{color:var(--bad)}.hidden{display:none}
small{display:block;margin-top:18px;color:var(--muted);font-size:12px}
</style></head><body><main><div class="card">
${
  fatal
    ? `<h1>Connect Brella</h1><p class="bad">${esc(fatal)}</p>`
    : `<h1>Connect Brella</h1>
<p>${clientName ? `<b>${esc(clientName)}</b> wants` : "An app wants"} to use your Brella account (events, agenda, meetings, chats).</p>
<form id="f1"><label for="email">Your Brella email</label>
<input id="email" type="email" autocomplete="email" required value="${email ? esc(email) : ""}">
<button id="b1">Email me a code</button></form>
<form id="f2" class="hidden"><div id="info" class="msg"></div>
<label for="code" style="margin-top:12px">Sign-in code</label>
<input id="code" class="code" inputmode="text" autocomplete="one-time-code" maxlength="12" required>
<button id="b2">Continue</button><button type="button" class="link" id="back">Use a different email</button></form>
<div id="err" class="msg bad"></div>
<small>Your code is sent straight to Brella and never shown to the AI assistant.</small>`
}
</div></main>
${
  fatal
    ? ""
    : `<script>
const req=new URLSearchParams(location.search).get('req');const $=id=>document.getElementById(id);
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({req},b))});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error((j.error&&j.error.message)||('HTTP '+r.status));return j}
$('f1').onsubmit=async e=>{e.preventDefault();$('err').textContent='';$('b1').disabled=true;try{const j=await post('/login/start',{email:$('email').value});$('info').textContent=j.instructions;$('f1').classList.add('hidden');$('f2').classList.remove('hidden');$('code').focus()}catch(x){$('err').textContent=x.message}finally{$('b1').disabled=false}};
$('f2').onsubmit=async e=>{e.preventDefault();$('err').textContent='';$('b2').disabled=true;try{const j=await post('/login/verify',{code:$('code').value});location.href=j.redirect}catch(x){$('err').textContent=x.message;$('code').value='';$('b2').disabled=false}};
$('back').onclick=()=>{$('f2').classList.add('hidden');$('f1').classList.remove('hidden')};
</script>`
}
</body></html>`;
}
