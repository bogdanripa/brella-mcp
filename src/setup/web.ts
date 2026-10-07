import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SetupError } from "../errors.js";
import type { SetupFlow } from "./flow.js";

/**
 * Browser setup surface for container deployments where nobody has a TTY.
 * Enabled only when SETUP_TOKEN is set; every API call must carry it.
 * This is an operator page, not an MCP tool: the model never sees the code.
 */

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(type.startsWith("text/html") ? { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" } : {}),
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new SetupError("INVALID_EMAIL", "Request too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Simple brute-force guard on the setup API (token guesses and code guesses).
const hits: number[] = [];
function throttled(): boolean {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) hits.shift();
  hits.push(now);
  return hits.length > 30;
}

export async function handleSetup(req: IncomingMessage, res: ServerResponse, flow: SetupFlow, setupToken: string): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  if (req.method === "GET" && (url.pathname === "/setup" || url.pathname === "/setup/")) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (!url.pathname.startsWith("/setup/api/")) return send(res, 404, { error: "not found" });
  if (throttled()) return send(res, 429, { error: { code: "RATE_LIMITED", message: "Slow down" } });
  const token = String(req.headers["x-setup-token"] ?? "");
  if (!token || !safeEqual(token, setupToken)) return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Wrong setup token" } });
  try {
    const action = url.pathname.slice("/setup/api/".length);
    if (req.method === "GET" && action === "accounts") return send(res, 200, { accounts: await flow.status() });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    const body = await readJson(req);
    switch (action) {
      case "start":
        return send(res, 200, await flow.start(String(body.email ?? ""), { alias: body.alias, makeDefault: !!body.make_default, skipRequest: !!body.manual }));
      case "verify":
        return send(res, 200, { account: await flow.verify(String(body.attempt_id ?? ""), String(body.code ?? "")) });
      case "remove":
        return send(res, 200, await flow.remove(String(body.email ?? "")));
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (e) {
    if (e instanceof SetupError) return send(res, 400, { error: { code: e.code, message: e.message } });
    return send(res, 500, { error: { code: "ERROR", message: "Setup failed" } });
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brella MCP setup</title>
<style>
:root{--bg:#f7f7f8;--fg:#18181b;--muted:#6b6b71;--card:#fff;--line:#e4e4e7;--acc:#4b3fd6;--ok:#16794a;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececef;--muted:#a1a1aa;--card:#1a1a1d;--line:#2e2e33;--acc:#8b80ff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}input[type=text],input[type=email],input[type=password]{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
button{margin-top:12px;padding:9px 14px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;cursor:pointer}button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:center}.msg{margin-top:10px;white-space:pre-wrap}.ok{color:var(--ok)}.bad{color:var(--bad)}
li{margin:6px 0}code{font-size:13px}.hidden{display:none}
</style></head><body><main>
<h1>Brella MCP setup</h1><p class="sub">Sign in Brella accounts for this MCP server. Codes are entered only here; they are never stored or shown to the assistant.</p>
<section><label for="tok">Setup token</label><input id="tok" type="password" autocomplete="off"><button class="secondary" id="load">Show accounts</button><ul id="accts"></ul></section>
<section><h2 style="font-size:17px;margin:0">Add or re-authenticate an account</h2>
<label for="email">Brella email</label><input id="email" type="email" autocomplete="off">
<label for="alias">Alias (optional)</label><input id="alias" type="text" autocomplete="off">
<div class="row"><input id="def" type="checkbox"><label for="def" style="margin:0">Make default</label></div>
<div class="row"><input id="manual" type="checkbox"><label for="manual" style="margin:0">I'll request the code myself on next.brella.io</label></div>
<button id="start">Send code</button><div id="m1" class="msg"></div>
<div id="codebox" class="hidden"><label for="code">Code from the email</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code"><button id="verify">Verify</button></div>
<div id="m2" class="msg"></div></section>
</main><script>
const $=id=>document.getElementById(id);let attempt=null;
async function api(path,body){const r=await fetch('/setup/api/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-setup-token':$('tok').value},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error((j.error&&(j.error.code+': '+j.error.message))||('HTTP '+r.status));return j}
function say(el,t,ok){el.textContent=t;el.className='msg '+(ok?'ok':'bad')}
async function load(){try{const j=await api('accounts');$('accts').innerHTML='';for(const a of j.accounts){const li=document.createElement('li');li.textContent=(a.is_default?'★ ':'')+a.email+(a.alias?' ('+a.alias+')':'')+' — '+(a.session_valid===true?'ready':a.session_valid===false?'setup required':'unknown');const b=document.createElement('button');b.className='secondary';b.textContent='Remove';b.style.marginLeft='8px';b.onclick=async()=>{if(!confirm('Sign out and remove '+a.email+'?'))return;try{const r=await api('remove',{email:a.email});alert('Upstream sign-out: '+r.upstream_sign_out);load()}catch(e){alert(e.message)}};li.appendChild(b);$('accts').appendChild(li)}if(!j.accounts.length)$('accts').innerHTML='<li>No accounts yet.</li>'}catch(e){$('accts').innerHTML='';const li=document.createElement('li');li.className='bad';li.textContent=e.message;$('accts').appendChild(li)}}
$('load').onclick=load;
$('start').onclick=async()=>{try{const j=await api('start',{email:$('email').value,alias:$('alias').value||undefined,make_default:$('def').checked,manual:$('manual').checked});attempt=j.attempt_id;say($('m1'),j.instructions,true);$('codebox').classList.remove('hidden');$('code').focus()}catch(e){say($('m1'),e.message,false)}};
$('verify').onclick=async()=>{try{const j=await api('verify',{attempt_id:attempt,code:$('code').value});$('code').value='';const a=j.account;say($('m2'),'Ready: '+a.email+(a.is_default?' (default)':'')+'\\nEvents: '+(a.events.map(e=>e.slug+' ('+e.status+')').join(', ')||'none'),true);$('codebox').classList.add('hidden');load()}catch(e){$('code').value='';say($('m2'),e.message,false)}};
</script></body></html>`;
