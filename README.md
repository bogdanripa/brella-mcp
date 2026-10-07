# brella-mcp

An MCP server that operates **your own Brella attendee account(s)** without a
browser: events, agenda and bookmarks, 1:1 meeting requests (accept, decline,
propose, reschedule, cancel), chats, attendee search and the activity feed.

* Sign-in is **setup-only**: an email one-time code entered in a local CLI or
  a token-gated setup page. No MCP tool accepts codes, tokens or passwords.
* Multiple accounts (email or alias), with a default.
* Sessions are stored AES-256-GCM-encrypted (Postgres or a `0600` file), and
  rotated `access-token`s are persisted after every response.
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

## Setting up an account

Brella attaches an invisible hCaptcha to its "email me a code" request. Setup
first asks Brella directly. If Brella requires the captcha, setup asks you to
open <https://next.brella.io/login>, choose **Continue with email**, enter
your address, and then type the emailed code **into setup**, not into the
Brella page.

**Deployed server**: open `https://<host>/setup`, paste the `SETUP_TOKEN`,
then enter your email and the code.

**Local**:

```bash
npm ci && npm run build
node dist/setup/cli.js add you@example.com --alias work --default   # prompts for the code (hidden)
node dist/setup/cli.js list
node dist/setup/cli.js remove you@example.com                        # upstream sign-out + local delete
```

If a tool later returns `SETUP_REQUIRED`, run setup again for that account.

## Running

| Variable | Purpose |
|---|---|
| `MCP_AUTH_TOKEN` | Required for HTTP (≥24 chars). Send `Authorization: Bearer …`, or use `/mcp/<token>` for clients that can't set headers. |
| `SETUP_TOKEN` | Enables the `/setup` page. Leave it unset to disable the page. |
| `BRELLA_SECRETS_KEY` | Passphrase for encrypting stored sessions. |
| `DATABASE_URL` | Postgres store. Otherwise a file under `BRELLA_MCP_HOME` (default `~/.brella-mcp`). |
| `PORT`, `HOST` | Default `3000`, `::`. The image uses port 80. |

```bash
npm start            # Streamable HTTP on /mcp (stateless), /health
npm run start:stdio  # stdio for local MCP clients
npm test             # contract tests against synthetic JSON:API fixtures
```

Claude Code example:

```bash
claude mcp add --transport http brella https://<host>/mcp --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

## Deployment

Pushing to `main` builds an arm64 image and redeploys the Pironman app
`brella-mcp` (`.github/workflows/deploy.yml`). Postgres is attached and
injected as `DATABASE_URL`.
