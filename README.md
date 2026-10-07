# brella-mcp

An MCP server that operates **your own Brella attendee account(s)** without a
browser: events, agenda and bookmarks, 1:1 meeting requests (accept, decline,
propose, reschedule, cancel), chats, attendee search and the activity feed.

* **OAuth for MCP clients**: add the server URL to ChatGPT, Claude or another
  client. It opens our `/login` page, where you enter your Brella email and
  then the code Brella emails you. You're sent back to the client with a token
  bound to that Brella account. No MCP tool accepts codes, tokens or passwords.
* Stateless: sessions, OAuth clients, codes and tokens are all kept in the
  store (Postgres, or a `0600` JSON file locally). Rotated Brella
  `access-token`s are persisted after every response.
* An expired Brella session makes the OAuth token fail with 401, so the client
  sends you through login again.
* Throttled to 2 requests/s per account. Only idempotent GETs are retried.
* Upstream routes are pinned from Brella's own web app; see
  [docs/upstream-contract.md](docs/upstream-contract.md).

## Tools

| Area | Tools |
|---|---|
| Accounts | `brella_list_accounts` |
| Events & profile | `brella_list_my_events`, `brella_get_event`, `brella_get_my_profile`, `brella_get_interest_catalog`, `brella_search_event` |
| Agenda | `brella_list_sessions`, `brella_get_session`, `brella_bookmark_session`, `brella_unbookmark_session`, `brella_get_my_agenda` (with overlap detection) |
| Meetings | `brella_list_meeting_requests`, `brella_get_meeting_request`, `brella_accept_meeting_request`, `brella_decline_meeting_request`, `brella_cancel_meeting`, `brella_list_available_meeting_slots`, `brella_propose_meeting`, `brella_propose_reschedule` |
| Attendees | `brella_list_attendees`, `brella_get_attendee`, `brella_find_attendees_by_interest` |
| Chat | `brella_list_conversations`, `brella_get_conversation_messages`, `brella_send_chat_message`, `brella_start_chat` |
| Activity | `brella_list_notifications`, `brella_get_networking_summary` |

Errors use stable codes such as `SETUP_REQUIRED`, `MEETING_STATE_CHANGED`,
`SLOT_UNAVAILABLE` and `RATE_LIMITED`. Write tools are idempotent and return
`already_applied: true` when nothing needed doing.

## Signing in

**From an MCP client**: point the client at `https://<host>/mcp`. It
discovers OAuth via `/.well-known/oauth-protected-resource`, registers
itself (dynamic client registration) and opens `/login`.

Brella's own web app attaches an invisible hCaptcha when it asks for a code.
If Brella refuses our request, the login page asks you to request the code at
<https://next.brella.io/login> (**Continue with email**). You then enter the
code on our page, not on Brella's.

**Local CLI** (stdio use, or the admin token):

```bash
npm ci && npm run build
node dist/setup/cli.js add you@example.com --alias work --default   # prompts for the code (hidden)
node dist/setup/cli.js request you@example.com                       # two-step variant
node dist/setup/cli.js verify you@example.com 123456
node dist/setup/cli.js list
node dist/setup/cli.js remove you@example.com                        # upstream sign-out + local delete
npx tsx scripts/call.ts brella_list_my_events '{"status":"ongoing"}' # call a tool locally
```

## Running

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | External base URL, used as the OAuth issuer (e.g. `https://brella-mcp-coolify.bogdanripa.com`). |
| `MCP_AUTH_TOKEN` | Optional static admin token with access to all accounts (`Authorization: Bearer …` or `/mcp/<token>`). |
| `DATABASE_URL` | Postgres store. Otherwise a file under `BRELLA_MCP_HOME` (default `~/.brella-mcp`). |
| `PORT`, `HOST` | Default `3000`, `::`. The image uses port 80. |

```bash
npm start            # Streamable HTTP on /mcp (stateless), OAuth endpoints, /login, /health
npm run start:stdio  # stdio for local MCP clients
npm test             # contract tests against synthetic JSON:API fixtures
```

Chat messages are sent the way Brella's app sends them: over its AnyCable
websocket. Each send opens a socket, sends one message and closes it, so the
server keeps no connections between requests. Everything else is REST.

## Deployment

Pushing to `main` builds an arm64 image and redeploys the Pironman app
`brella-mcp` (`.github/workflows/deploy.yml`). Postgres is attached and
injected as `DATABASE_URL`.
