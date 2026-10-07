import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../config.js";
import { registerActivityTools } from "./activity.js";
import { registerAgendaTools } from "./agenda.js";
import { registerAttendeeTools } from "./attendees.js";
import { registerChatTools } from "./chat.js";
import type { ToolContext } from "./common.js";
import { registerAccountTools, registerEventTools } from "./events.js";
import { registerMeetingTools } from "./meetings.js";

const INSTRUCTIONS = `Operate the user's own Brella attendee account(s): events, agenda/bookmarks, 1:1 meeting requests, chats, attendees and activity.
Sign-in is not available here: accounts are created by the operator's setup flow. If a tool returns SETUP_REQUIRED, tell the user to rerun setup for that account — never ask them for a sign-in code.
IDs are account-scoped. Write tools act on one explicit meeting/session/conversation at a time and are idempotent (already_applied: true).
Before accepting a meeting or bookmarking a session, check brella_get_my_agenda for overlaps.`;

/** Build an MCP server exposing exactly the §7 catalog (no auth/sign-in tools). */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "brella-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
  registerAccountTools(server, ctx);
  registerEventTools(server, ctx);
  registerAgendaTools(server, ctx);
  registerMeetingTools(server, ctx);
  registerAttendeeTools(server, ctx);
  registerChatTools(server, ctx);
  registerActivityTools(server, ctx);
  return server;
}
