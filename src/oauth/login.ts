import express, { type Router } from "express";
import { BRELLA_LOGIN_URL, EMAIL_RE } from "../brella/auth.js";
import type { Config } from "../config.js";
import { SetupError } from "../errors.js";
import { MAX_CODE_TRIES, type SetupFlow } from "../setup/flow.js";
import type { Store } from "../store/types.js";
import { type BrellaOAuthProvider, PENDING_TTL, type PendingAuth } from "./provider.js";

/**
 * /login: the page an MCP client sends the user to.
 *   Default: email → user requests the code on next.brella.io (Brella only sends it
 *            behind its own captcha) → user types the code here → we verify it.
 *   Option:  email + Brella password (for users who set one).
 * On success the Brella session is stored, an OAuth code is issued and the browser
 * returns to the client. All state lives in the store (keyed by the pending id).
 */
export function loginRouter(store: Store, flow: SetupFlow, provider: BrellaOAuthProvider, cfg: Config): Router {
  const r = express.Router();
  r.use("/login", express.json({ limit: "8kb" }));

  const load = async (id: unknown): Promise<PendingAuth | null> => (typeof id === "string" && id ? store.kvGet<PendingAuth>("pending", id) : null);

  /** Count an attempt; refuse once the limit is reached. */
  const spendTry = async (id: string, p: PendingAuth, res: express.Response): Promise<boolean> => {
    if (p.tries >= MAX_CODE_TRIES) {
      await store.kvDelete("pending", id);
      res.status(400).json({ error: { code: "TOO_MANY_ATTEMPTS", message: "Too many wrong attempts. Start again from your app." } });
      return false;
    }
    await store.kvPut("pending", id, { ...p, tries: p.tries + 1 }, PENDING_TTL);
    return true;
  };

  r.get("/login", async (req, res) => {
    const p = await load(req.query.req);
    res.set({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    });
    if (!p) return res.status(400).type("html").send(page("This sign-in link expired. Go back to your app and connect again.", null, null));
    res.type("html").send(page(null, p.client_name ?? null, p.email ?? null));
  });

  // Remember the email; the code itself is requested by the user on Brella's site.
  r.post("/login/email", async (req, res) => {
    const id = req.body?.req;
    const p = await load(id);
    if (!p) return res.status(400).json({ error: { code: "SETUP_ATTEMPT_EXPIRED", message: "This sign-in request expired. Start again from your app." } });
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: { code: "INVALID_EMAIL", message: "That doesn't look like an email address." } });
    await store.kvPut("pending", id, { ...p, email, tries: 0 } satisfies PendingAuth, PENDING_TTL);
    res.json({ email, brella_login_url: BRELLA_LOGIN_URL });
  });

  r.post("/login/verify", async (req, res) => {
    const id = req.body?.req;
    const p = await load(id);
    if (!p || !p.email) return res.status(400).json({ error: { code: "SETUP_ATTEMPT_NOT_FOUND", message: "Enter your email first." } });
    if (!(await spendTry(id, p, res))) return;
    try {
      const verified = await flow.api.verifyCode(cfg, p.email, String(req.body?.code ?? ""));
      await flow.completeSignIn({ email: p.email, makeDefault: false }, verified.session, verified.user);
      res.json({ redirect: await provider.completeAuthorization(id, p, p.email) });
    } catch (e) {
      sendError(res, e);
    }
  });

  r.post("/login/password", async (req, res) => {
    const id = req.body?.req;
    const p = await load(id);
    if (!p) return res.status(400).json({ error: { code: "SETUP_ATTEMPT_EXPIRED", message: "This sign-in request expired. Start again from your app." } });
    const email = String(req.body?.email ?? p.email ?? "").trim().toLowerCase();
    if (!(await spendTry(id, { ...p, email }, res))) return;
    try {
      // The password is passed straight to Brella and never stored or logged.
      const ready = await flow.signInWithPassword(email, String(req.body?.password ?? ""));
      res.json({ redirect: await provider.completeAuthorization(id, p, ready.email) });
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
  const who = clientName ? `<b>${esc(clientName)}</b> wants` : "An app wants";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Brella</title>
<style>
:root{--bg:#f6f6f8;--fg:#18181b;--muted:#6b6b71;--card:#fff;--line:#e4e4e7;--acc:#4b3fd6;--acc-soft:#ecebff;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececef;--muted:#a1a1aa;--card:#1a1a1d;--line:#2e2e33;--acc:#8b80ff;--acc-soft:#22213a;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:440px;margin:0 auto;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
h1{font-size:21px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}
label{display:block;font-size:14px;margin:0 0 6px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:var(--fg);font:inherit}
input.code{letter-spacing:.3em;font-size:22px;text-align:center;text-transform:uppercase}
button,.btn{display:block;width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-align:center;text-decoration:none}
.btn.secondary{background:var(--acc-soft);color:var(--acc)}
button:disabled{opacity:.6;cursor:default}
.link{background:none;color:var(--acc);width:auto;padding:0;margin:14px auto 0;font-weight:400;font-size:14px}
ol{margin:0 0 4px;padding-left:20px;color:var(--muted);font-size:15px}ol li{margin:4px 0}ol b{color:var(--fg)}
.msg{margin-top:12px;font-size:14px}.bad{color:var(--bad)}.hidden{display:none}
.note{font-size:13px;color:var(--muted);margin-top:10px}
small{display:block;margin-top:18px;color:var(--muted);font-size:12px}
</style></head><body><main><div class="card">
${
  fatal
    ? `<h1>Connect Brella</h1><p class="bad">${esc(fatal)}</p>`
    : `<h1>Connect Brella</h1>
<p>${who} to use your Brella account: events, agenda, meetings and chats.</p>

<form id="f1"><label for="email">Your Brella email</label>
<input id="email" type="email" autocomplete="email" required value="${email ? esc(email) : ""}">
<button id="b1">Continue</button></form>

<form id="f2" class="hidden">
<ol>
<li>Tap <b>Get my code from Brella</b>. Brella opens in a new tab.</li>
<li>Choose <b>Continue with email</b>, enter <b id="em"></b> and press continue.</li>
<li>Come back here and type the 6-character code from Brella's email. <b>Don't enter it on Brella's page.</b></li>
</ol>
<a class="btn secondary" id="brella" href="${BRELLA_LOGIN_URL}" target="_blank" rel="noopener noreferrer">Get my code from Brella ↗</a>
<label for="code" style="margin-top:18px">Sign-in code</label>
<input id="code" class="code" autocomplete="one-time-code" maxlength="12" required>
<button id="b2">Continue</button>
</form>

<form id="f3" class="hidden">
<label for="pemail">Brella email</label><input id="pemail" type="email" autocomplete="username" required>
<label for="pw" style="margin-top:12px">Brella password</label><input id="pw" type="password" autocomplete="current-password" required>
<button id="b3">Sign in</button>
<div class="note">Only works if you've set a password in Brella. It goes to Brella once to sign you in and is never stored.</div>
</form>

<button type="button" class="link" id="toPw">Sign in with a Brella password instead</button>
<button type="button" class="link hidden" id="toCode">Use an email code instead</button>
<div id="err" class="msg bad"></div>
<small>Codes and passwords go only to Brella, never to the AI assistant. Independent project, not affiliated with Brella.</small>`
}
</div></main>
${
  fatal
    ? ""
    : `<script>
const req=new URLSearchParams(location.search).get('req');const $=id=>document.getElementById(id);
const show=(...ids)=>{for(const f of ['f1','f2','f3'])$(f).classList.toggle('hidden',!ids.includes(f))};
async function post(p,b){const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({req},b))});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error((j.error&&j.error.message)||('HTTP '+r.status));return j}
const busy=(b,on)=>{$(b).disabled=on;if(on)$('err').textContent=''};
$('f1').onsubmit=async e=>{e.preventDefault();busy('b1',true);try{const j=await post('/login/email',{email:$('email').value});$('em').textContent=j.email;show('f2');}catch(x){$('err').textContent=x.message}finally{busy('b1',false)}};
$('f2').onsubmit=async e=>{e.preventDefault();busy('b2',true);try{const j=await post('/login/verify',{code:$('code').value.trim()});location.href=j.redirect}catch(x){$('err').textContent=x.message;$('code').value='';busy('b2',false)}};
$('f3').onsubmit=async e=>{e.preventDefault();busy('b3',true);try{const j=await post('/login/password',{email:$('pemail').value,password:$('pw').value});location.href=j.redirect}catch(x){$('err').textContent=x.message;$('pw').value='';busy('b3',false)}};
$('toPw').onclick=()=>{$('pemail').value=$('email').value;show('f3');$('toPw').classList.add('hidden');$('toCode').classList.remove('hidden');$('err').textContent='';$('pw').focus()};
$('toCode').onclick=()=>{show('f1');$('toCode').classList.add('hidden');$('toPw').classList.remove('hidden');$('err').textContent=''};
</script>`
}
</body></html>`;
}
