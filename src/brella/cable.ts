import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import type { Config } from "../config.js";
import { BrellaError } from "../errors.js";
import type { AccountClient } from "./http.js";
import { CHAT_CHANNEL, routes } from "./routes.js";

export interface CableSendResult {
  uuid: string;
  /** The server echoed the message back as `new_message` on the channel. */
  echoed: boolean;
  message?: Record<string, unknown>;
}

/**
 * Chat messages are not sent over REST: the web app performs `send_message`
 * on the AnyCable `ChatConversationsChannel`, authenticated with a one-time
 * token from POST /me/one_time_tokens. We open a socket for one message and
 * close it again.
 */
export async function sendChatMessage(
  client: AccountClient,
  cfg: Config,
  conversationId: string,
  content: string,
  timeoutMs = 12_000,
): Promise<CableSendResult> {
  const ottDoc = await client.request("POST", routes.oneTimeToken(), { body: {} });
  const ott = ottDoc.data[0]?.token as string | undefined;
  if (!ott) throw new BrellaError("UPSTREAM_CHANGED", "Brella did not return a one-time socket token");

  const identifier = JSON.stringify({ channel: CHAT_CHANNEL, conversation_id: Number(conversationId) || conversationId });
  const uuid = randomUUID();
  const url = `${cfg.socketUrl}?ott=${encodeURIComponent(ott)}`;

  return new Promise<CableSendResult>((resolve, reject) => {
    let sent = false;
    let settled = false;
    const ws = new WebSocket(url, ["actioncable-v1-ext-json", "actioncable-v1-json"], {
      headers: { Accept: "application/vnd.brella.v4+json", "User-Agent": cfg.userAgent },
      handshakeTimeout: 10_000,
      // Same opt-in as Node's fetch: only route via HTTPS_PROXY when NODE_USE_ENV_PROXY=1 (dev sandboxes).
      ...(process.env.NODE_USE_ENV_PROXY === "1" && process.env.HTTPS_PROXY ? { agent: new HttpsProxyAgent(process.env.HTTPS_PROXY) } : {}),
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(() => {
      // Sent but not echoed: delivery unknown, caller re-reads the conversation.
      if (sent) finish(() => resolve({ uuid, echoed: false }));
      else finish(() => reject(new BrellaError("UPSTREAM_UNREACHABLE", "Chat socket did not become ready in time")));
    }, timeoutMs);

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "welcome") {
        ws.send(JSON.stringify({ command: "subscribe", identifier }));
      } else if (msg.type === "reject_subscription") {
        finish(() => reject(new BrellaError("CONVERSATION_NOT_FOUND", `Conversation ${conversationId} is not accessible for this account`)));
      } else if (msg.type === "confirm_subscription" && !sent) {
        sent = true;
        ws.send(
          JSON.stringify({
            command: "message",
            identifier,
            data: JSON.stringify({ action: "send_message", content, uuid }),
          }),
        );
      } else if (msg.type === "disconnect") {
        if (sent) finish(() => resolve({ uuid, echoed: false }));
        else finish(() => reject(new BrellaError("SETUP_REQUIRED", "Brella refused the chat socket for this session", { account: client.email })));
      } else if (msg.message && typeof msg.message === "object") {
        const m = msg.message;
        if (m.event === "new_message" && m.message && (m.message.uuid === uuid || m.message.content === content)) {
          finish(() => resolve({ uuid, echoed: true, message: m.message }));
        }
      }
    });
    ws.on("error", () => {
      if (sent) finish(() => resolve({ uuid, echoed: false }));
      else finish(() => reject(new BrellaError("UPSTREAM_UNREACHABLE", "Chat socket connection failed")));
    });
    ws.on("close", () => {
      if (sent) finish(() => resolve({ uuid, echoed: false }));
      else finish(() => reject(new BrellaError("UPSTREAM_UNREACHABLE", "Chat socket closed before the message was sent")));
    });
  });
}
