# Upstream contract (Brella attendee API)

Brella publishes no attendee API. Routes below were **pinned from the official
web app's JavaScript bundle** (`next.brella.io`, Expo web build, fetched
2026-10-07), which ships a complete `url` table plus the request bodies its
screens send. No browser, account, or credential was used to obtain them.

Base: `https://api.brella.io/api` · headers: `Accept: application/vnd.brella.v4+json`,
`Content-Type: application/json`, Devise-Token-Auth headers `access-token`, `client`,
`uid` (+ `expiry`, `token-type`), rotated from response headers.

Confidence legend: **BUNDLE** = route and body seen in the web app bundle;
**PUBLIC** = also in public reverse-engineering code; **SHAPE?** = response
attribute names inferred, mappers read several candidates.

## Auth (setup only, never an MCP tool)

| Step | Request | Notes |
|---|---|---|
| Request email code | `POST /one_click_links` `{ hcaptcha_token, one_click_link: { email } }` | BUNDLE. The web app attaches an **invisible hCaptcha** token. We never solve captchas: setup tries without one and, if Brella insists, the operator triggers the email at next.brella.io/login and enters the code only in setup. |
| Verify code | `POST /one_click_links/sign_in` `{ token: "<6-char code>", email }` | BUNDLE. Session comes back in `access-token`/`client`/`uid` response headers. 429 = "wait an hour". |
| Validate session | `GET /me/user` | BUNDLE (the app has no `validate_token` call). |
| Sign out | `DELETE /auth/sign_out` | BUNDLE + PUBLIC. |
| Password sign-in | `POST /auth/sign_in` | BUNDLE + PUBLIC. **Not used** (email code only). |

## Data/action routes

| Tool(s) | Request | Confidence |
|---|---|---|
| list_my_events | `GET /me/events` | BUNDLE, SHAPE? |
| get_event | `GET /events/{slug}` | BUNDLE + PUBLIC |
| get_my_profile | `GET /me/events/{slug}/me_attendee`, `GET /me/events/{slug}/attendee_interests` | BUNDLE + PUBLIC |
| interest catalog | `GET /events/{slug}/interests` (categories → `children`) | BUNDLE + PUBLIC |
| search_event | `GET /me/events/{slug}/search?search=` | BUNDLE (+PUBLIC used `q`) |
| list_sessions | `GET /me/events/{slug}/schedule?date=all` (timeslots collected from the payload) | BUNDLE, SHAPE? |
| get_session | `GET /events/{slug}/timeslots/{id}` | BUNDLE |
| bookmarks | `GET /me/events/{slug}/timeslot_bookmarks`; `POST …/timeslot_bookmarks?timeslot_id=`; `DELETE …/timeslot_bookmarks/{bookmarkId}` | BUNDLE |
| meetings list/detail | `GET /me/meetings?event_id=&page[size]=`; `GET /me/meetings/{id}` | BUNDLE, SHAPE? |
| accept | `PATCH /me/meetings/{id}/accept` | BUNDLE |
| decline | `PATCH /me/meetings/{id}/reject` `{ meeting: { message, freeze_chat } }` | BUNDLE |
| cancel | `PATCH /me/meetings/{id}/cancel` `{ meeting: { message, freeze_chat } }` | BUNDLE |
| reschedule (native) | `PATCH /me/meetings/{id}/reschedule` `{ meeting: { message, timeslot_id, location_id \| unset_location } }` | BUNDLE |
| propose meeting | `POST /me/meetings` `{ meeting: { user_id, event_id, message, timeslot_id } }` | BUNDLE (PUBLIC listed `/suggest`; the app posts to the collection) |
| available slots | `GET /events/{slug}/attendees/{attendeeId}/timeslots/suggested[?meeting_id=]`; `GET /me/events/{slug}/meetings/networking_availability[/{date}]` | BUNDLE, SHAPE? |
| start_chat | `POST /me/meetings/start_chat` `{ meeting: { user_id, event_id, message } }` | BUNDLE + PUBLIC |
| conversations | derived from meetings (`chat-conversation` relationship) | inferred |
| messages (read) | `GET /me/chat_conversations/{id}/chat_messages` | BUNDLE + PUBLIC |
| messages (send) | **WebSocket**, not REST: `POST /me/one_time_tokens` → `wss://api.brella.io/api/v4/socket/me?ott=…` (AnyCable, `actioncable-v1-ext-json`), subscribe `Api::Latest::Me::ChatConversationsChannel {conversation_id}`, perform `send_message {content, uuid}`; server echoes `new_message` | BUNDLE |
| attendees | `GET /events/{slug}/attendees?search=`; filtered `POST /events/{slug}/attendees {interest_ids, page}` | BUNDLE + PUBLIC |
| attendee | `GET /events/{slug}/attendees/{id}` | BUNDLE + PUBLIC |
| notifications | `GET /me/events/{slug}/notifications/history` (read state is device-local in the app) | BUNDLE, SHAPE? |

## Still to pin with a redacted capture (spec §10)

* Response attribute names for events, timeslots, meetings (sender/receiver vs
  participants), notifications. Mappers accept several candidates and return
  `null` rather than guess; `include_raw: true` exposes the upstream object.
* Meeting status enum values beyond `pending`/`accepted`/`rejected`/`cancelled`
  (unknown values map to `unknown` with `raw_status`).
* Whether `POST /one_click_links` ever succeeds without an hCaptcha token.
