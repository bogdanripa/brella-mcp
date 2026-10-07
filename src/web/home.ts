/** Public landing page at "/", for people looking for a Brella connector for their AI assistant. */

const GITHUB = "https://github.com/bogdanripa/brella-mcp";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function homePage(publicUrl: URL): string {
  const mcp = esc(new URL("/mcp", publicUrl).toString());
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brella connector for ChatGPT &amp; Claude</title>
<meta name="description" content="Use your Brella event account from ChatGPT, Claude and other AI assistants: agenda, meeting requests, chats and attendees, through one MCP connector.">
<meta property="og:title" content="Brella connector for ChatGPT & Claude">
<meta property="og:description" content="Plan your conference from your AI assistant: agenda, 1:1 meetings, chats and people, all on your own Brella account.">
<style>
:root{--bg:#fbfaf7;--fg:#17171a;--muted:#5d5d66;--card:#fff;--line:#e7e5df;--acc:#3f35c8;--acc-soft:#ecebff;--code:#f2f1ec}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f12;--fg:#ececf0;--muted:#a3a3ad;--card:#18181c;--line:#2a2a30;--acc:#9a91ff;--acc-soft:#22213a;--code:#1f1f24}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--acc)}.wrap{max-width:980px;margin:0 auto;padding:0 20px}
header{padding:20px 0;display:flex;justify-content:space-between;align-items:center}
.brand{font-weight:700;letter-spacing:-.01em}.brand span{color:var(--acc)}
nav a{color:var(--muted);text-decoration:none;margin-left:18px;font-size:15px}nav a:hover{color:var(--fg)}
.hero{padding:56px 0 40px}
.eyebrow{display:inline-block;font-size:13px;font-weight:600;color:var(--acc);background:var(--acc-soft);padding:4px 10px;border-radius:999px}
h1{font-size:clamp(34px,5.6vw,56px);line-height:1.08;letter-spacing:-.03em;margin:18px 0 16px;max-width:760px}
.lede{font-size:clamp(18px,2.2vw,21px);color:var(--muted);max-width:640px;margin:0 0 28px}
.cta{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;padding:12px 18px;border-radius:10px;font-weight:600;text-decoration:none;font-size:16px}
.btn.primary{background:var(--acc);color:#fff}.btn.ghost{border:1px solid var(--line);color:var(--fg)}
.url{margin-top:22px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.url code{background:var(--code);border:1px solid var(--line);padding:10px 12px;border-radius:10px;font-size:15px;word-break:break-all}
.copy{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:10px 12px;font:inherit;font-size:14px;cursor:pointer}
section{padding:44px 0;border-top:1px solid var(--line)}
h2{font-size:clamp(24px,3.4vw,32px);letter-spacing:-.02em;margin:0 0 8px}
.sub{color:var(--muted);margin:0 0 26px;max-width:640px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px}
.card h3{margin:0 0 6px;font-size:17px}.card p{margin:0;color:var(--muted);font-size:15px}
.chat{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;display:grid;gap:10px;max-width:720px}
.bubble{padding:10px 14px;border-radius:14px;max-width:88%;font-size:15.5px}
.me{background:var(--acc);color:#fff;justify-self:end;border-bottom-right-radius:4px}
.ai{background:var(--code);justify-self:start;border-bottom-left-radius:4px}
ol.steps{counter-reset:s;list-style:none;padding:0;margin:0;display:grid;gap:14px}
ol.steps li{counter-increment:s;position:relative;padding:16px 16px 16px 58px;background:var(--card);border:1px solid var(--line);border-radius:14px}
ol.steps li::before{content:counter(s);position:absolute;left:16px;top:15px;width:28px;height:28px;border-radius:50%;background:var(--acc-soft);color:var(--acc);font-weight:700;display:grid;place-items:center;font-size:14px}
ol.steps b{display:block;margin-bottom:2px}ol.steps span{color:var(--muted);font-size:15px}
.clients{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.clients .card code{background:var(--code);padding:2px 6px;border-radius:6px;font-size:13.5px;word-break:break-all}
details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
summary{cursor:pointer;font-weight:600}details p{color:var(--muted);margin:10px 0 0;font-size:15.5px}
footer{padding:30px 0 48px;color:var(--muted);font-size:14px;border-top:1px solid var(--line)}
@media (max-width:560px){nav a:not(:last-child){display:none}.hero{padding-top:28px}}
</style></head><body>
<div class="wrap">
<header><div class="brand">Brella <span>connector</span></div>
<nav><a href="#what">What it does</a><a href="#connect">Connect</a><a href="#faq">FAQ</a><a href="${GITHUB}">GitHub</a></nav></header>

<div class="hero">
<span class="eyebrow">For ChatGPT, Claude &amp; any MCP client</span>
<h1>Run your conference networking from your AI assistant.</h1>
<p class="lede">Connect your Brella event account to ChatGPT or Claude. Ask what's on your agenda, triage meeting requests, find the right people and reply to chats, without tapping through the event app between sessions.</p>
<div class="cta"><a class="btn primary" href="#connect">Connect in 2 minutes</a><a class="btn ghost" href="${GITHUB}">View source on GitHub</a></div>
<div class="url"><code id="u">${mcp}</code><button class="copy" id="c" type="button">Copy URL</button></div>
</div>

<section id="what">
<h2>Ask in plain language</h2>
<p class="sub">Your assistant reads and acts on your own Brella account, the same things you can do in the Brella app.</p>
<div class="chat">
<div class="bubble me">Any new meeting requests at the conference? Accept the ones that don't clash with my agenda.</div>
<div class="bubble ai">You have 3 pending requests. Two fit your agenda and are now accepted (13:45 with a VC partner, 15:30 with a growth lead). The third, at 09:00, overlaps your bookmarked keynote. Should I propose 11:15 instead?</div>
<div class="bubble me">Yes, and find me founders interested in AI search.</div>
</div>
<div class="grid" style="margin-top:22px">
<div class="card"><h3>Agenda</h3><p>Browse sessions by day, stage or topic. Bookmark talks and see your agenda with overlaps flagged.</p></div>
<div class="card"><h3>1:1 meetings</h3><p>Review, accept or decline requests with a note, find mutually free slots, propose meetings and reschedule.</p></div>
<div class="card"><h3>Chats</h3><p>Read conversations and send replies, or start a chat with someone you want to meet.</p></div>
<div class="card"><h3>People</h3><p>Search attendees and match them against interests like "AI search" or "growth".</p></div>
<div class="card"><h3>What changed</h3><p>A quick summary of new requests, replies and cancellations, handy for an hourly check-in.</p></div>
<div class="card"><h3>Several accounts</h3><p>Each connection signs in to one Brella account. Connect again to use another one.</p></div>
</div>
</section>

<section id="connect">
<h2>Connect</h2>
<p class="sub">You only need the connector URL and access to the email you use for Brella.</p>
<div class="clients">
<div class="card"><h3>ChatGPT</h3><p>Settings → Apps &amp; Connectors → create a custom connector (turn on Developer mode under Advanced if you don't see the option). Paste <code>${mcp}</code> and choose OAuth.</p></div>
<div class="card"><h3>Claude</h3><p>Settings → Connectors → Add custom connector. Paste <code>${mcp}</code>, then click Connect.</p></div>
<div class="card"><h3>Claude Code &amp; others</h3><p><code>claude mcp add --transport http brella ${mcp}</code><br>Any client that supports remote MCP servers with OAuth works.</p></div>
</div>
<ol class="steps" style="margin-top:22px">
<li><b>Add the connector</b><span>Your assistant opens a sign-in page on this site.</span></li>
<li><b>Get a code from Brella</b><span>Enter your email, then tap through to Brella's login page, which emails you a one-time code. Have a Brella password? You can use that instead.</span></li>
<li><b>Type the code here</b><span>Enter it on our page, not Brella's, and you're sent straight back to your assistant.</span></li>
</ol>
</section>

<section id="faq">
<h2>Questions</h2>
<details><summary>Is this made by Brella?</summary><p>No. It's an independent, open-source connector. It works with your own Brella attendee account through the same requests the Brella web app makes. "Brella" is a trademark of its owner.</p></details>
<details><summary>Does the AI see my sign-in code or password?</summary><p>No. You type them on this site's sign-in page, never in the chat, and they go only to Brella. Passwords are never stored. The assistant only gets a token that works for the account you signed in with.</p></details>
<details><summary>Why do I get the code from Brella's own page?</summary><p>Brella only sends sign-in codes from its own site, which protects them with a captcha. You request the code there, and this page turns it into a connection.</p></details>
<details><summary>What is stored?</summary><p>Your Brella session for the signed-in account, so the connector can act for you, plus the tokens your assistant uses. Event data isn't copied or kept. Everything else is fetched live from Brella when you ask.</p></details>
<details><summary>Can it send messages or accept meetings without me?</summary><p>It acts only when your assistant calls it, one meeting, session or conversation at a time. There are no bulk-messaging tools. Most assistants ask you to confirm before an action that changes something.</p></details>
<details><summary>How do I disconnect?</summary><p>Remove the connector in your assistant. Sessions expire on Brella's side too, and when that happens you're asked to sign in again.</p></details>
<details><summary>Can I run it myself?</summary><p>Yes. The code, setup instructions and the documented Brella routes are on <a href="${GITHUB}">GitHub</a>.</p></details>
</section>

<footer>Open source on <a href="${GITHUB}">GitHub</a> · Independent project, not affiliated with Brella.</footer>
</div>
<script>document.getElementById('c').onclick=function(){navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('u').textContent).then(()=>{this.textContent='Copied'})}</script>
</body></html>`;
}
