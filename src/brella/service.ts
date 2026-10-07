import type { Config } from "../config.js";
import { BrellaError } from "../errors.js";
import type { AccountMeta, Store } from "../store/types.js";
import { AccountClient } from "./http.js";
import { collect, type Document, type Node, pick } from "./jsonapi.js";
import {
  type EventModel,
  type MeContext,
  type MeetingModel,
  mapEvent,
  mapMeeting,
  mapSession,
  parseEventSlug,
  type SessionModel,
} from "./mappers.js";
import { routes } from "./routes.js";

export const CATALOG_TTL = 60_000; // §5.5: event/session/interest/attendee pages
export const LIVE_TTL = 5_000; // §5.5: meetings, conversations, notifications
export const MAX_PAGES = 20; // §5.2 fetch_all cap
export const MAX_PAGE_SIZE = 120;

export interface PageInput {
  page_number?: number;
  page_size?: number;
  fetch_all?: boolean;
}

export interface PageInfo {
  number: number;
  size: number;
  total_items?: number;
  total_pages?: number;
  has_next: boolean;
  capped?: boolean;
}

export function pageMeta(doc: Document, number: number, size: number, got: number): PageInfo {
  const m = doc.meta ?? {};
  const totalItems = pick<number>(m, "totalCount", "total", "totalEntries", "count", "pagination.totalCount");
  const totalPages = pick<number>(m, "totalPages", "pageCount", "pagination.totalPages");
  const hasNext =
    totalPages != null ? number < Number(totalPages) : totalItems != null ? number * size < Number(totalItems) : got >= size;
  return {
    number,
    size,
    ...(totalItems != null ? { total_items: Number(totalItems) } : {}),
    ...(totalPages != null ? { total_pages: Number(totalPages) } : {}),
    has_next: hasNext,
  };
}

/** Run a paged GET once, or across pages up to MAX_PAGES when fetch_all. */
export async function paged(
  fetchPage: (number: number, size: number) => Promise<Document>,
  input: PageInput,
  defaultSize: number,
): Promise<{ nodes: Node[]; page: PageInfo }> {
  const size = Math.min(Math.max(input.page_size ?? defaultSize, 1), MAX_PAGE_SIZE);
  let number = Math.max(input.page_number ?? 1, 1);
  const nodes: Node[] = [];
  let page: PageInfo;
  let pages = 0;
  for (;;) {
    const doc = await fetchPage(number, size);
    nodes.push(...doc.data);
    pages++;
    page = pageMeta(doc, number, size, doc.data.length);
    if (!input.fetch_all || !page.has_next) break;
    if (pages >= MAX_PAGES) {
      page.capped = true;
      break;
    }
    number++;
  }
  return { nodes, page: { ...page, number: Math.max(input.page_number ?? 1, 1) } };
}

export function pageQuery(number: number, size: number): Record<string, number> {
  return { "page[number]": number, "page[size]": size };
}

/** Per-account facade over the upstream API. */
export class BrellaAccount {
  private meCache: { at: number; me: MeContext & { email?: string } } | null = null;

  constructor(
    readonly meta: AccountMeta,
    readonly http: AccountClient,
    readonly cfg: Config,
  ) {}

  get email(): string {
    return this.meta.email;
  }

  async me(): Promise<MeContext> {
    if (this.meCache && Date.now() - this.meCache.at < 10 * 60_000) return this.meCache.me;
    const doc = await this.http.get(routes.meUser(), { cacheTtlMs: CATALOG_TTL });
    const u = doc.data[0];
    const me = { userId: u?.id ? String(u.id) : this.meta.user_id ?? null, email: u?.email };
    this.meCache = { at: Date.now(), me };
    return me;
  }

  async meWithAttendee(slug: string): Promise<MeContext> {
    const me = await this.me();
    try {
      const att = await this.meAttendee(slug);
      return { ...me, attendeeId: att?.id ? String(att.id) : null };
    } catch {
      return me;
    }
  }

  async event(eventInput: string): Promise<EventModel & { raw: Node }> {
    const slug = parseEventSlug(eventInput);
    if (!slug) throw new BrellaError("EVENT_NOT_FOUND", "Empty event slug");
    const doc = await this.http.get(routes.event(slug), { cacheTtlMs: CATALOG_TTL, notFound: "EVENT_NOT_FOUND" });
    const n = doc.data[0];
    if (!n) throw new BrellaError("EVENT_NOT_FOUND", `Event ${slug} not found for ${this.email}`);
    const ev = mapEvent(n);
    if (!ev.slug) ev.slug = slug;
    return { ...ev, raw: n };
  }

  async meAttendee(slug: string): Promise<Node | null> {
    const doc = await this.http.get(routes.meAttendee(slug), { cacheTtlMs: CATALOG_TTL, notFound: "EVENT_NOT_FOUND" });
    return doc.data[0] ?? null;
  }

  async myEvents(): Promise<Node[]> {
    const doc = await this.http.get(routes.meEvents(), { cacheTtlMs: CATALOG_TTL, query: { "page[size]": 100 } });
    return doc.data;
  }

  // ---- bookmarks & sessions ----

  /** timeslot id → bookmark id */
  async bookmarks(slug: string, fresh = false): Promise<Map<string, string>> {
    const doc = await this.http.get(routes.timeslotBookmarks(slug), {
      cacheTtlMs: fresh ? undefined : LIVE_TTL,
      query: { "page[size]": 120 },
      notFound: "EVENT_NOT_FOUND",
    });
    const map = new Map<string, string>();
    for (const b of doc.data) {
      const tid = pick(b, "timeslot.id", "timeslotId", "bookmarkableId");
      if (tid != null && b.id != null) map.set(String(tid), String(b.id));
    }
    return map;
  }

  /** All agenda timeslots for an event (the schedule payload carries them). */
  async sessionNodes(slug: string): Promise<Node[]> {
    const doc = await this.http.get(routes.schedule(slug), { cacheTtlMs: CATALOG_TTL, query: { date: "all" }, notFound: "EVENT_NOT_FOUND" });
    const byId = new Map<string, Node>();
    for (const n of [...collect(doc.data, "timeslot"), ...[...doc.index.values()].filter((x) => x.type === "timeslot")]) {
      const prev = byId.get(String(n.id));
      // Prefer the most fully-hydrated copy.
      if (!prev || Object.keys(n).length > Object.keys(prev).length) byId.set(String(n.id), n);
    }
    return [...byId.values()].filter((n) => !/networking|meeting_slot|^meeting$/i.test(String(pick(n, "timeslotType", "kind") ?? "")));
  }

  async sessions(slug: string, tz: string | null): Promise<SessionModel[]> {
    const [nodes, bm] = await Promise.all([this.sessionNodes(slug), this.bookmarks(slug).catch(() => new Map<string, string>())]);
    const ids = new Set(bm.keys());
    return nodes
      .map((n) => mapSession(n, slug, ids, tz))
      .sort((a, b) => String(a.starts_at ?? "").localeCompare(String(b.starts_at ?? "")));
  }

  async session(slug: string, id: string, tz: string | null): Promise<SessionModel> {
    const [doc, bm] = await Promise.all([
      this.http.get(routes.timeslot(slug, id), { cacheTtlMs: CATALOG_TTL, notFound: "SESSION_NOT_FOUND" }),
      this.bookmarks(slug).catch(() => new Map<string, string>()),
    ]);
    const n = doc.data[0];
    if (!n) throw new BrellaError("SESSION_NOT_FOUND", `Session ${id} not found in ${slug}`);
    return mapSession(n, slug, new Set(bm.keys()), tz);
  }

  // ---- meetings ----

  async meetingNodes(eventId: string, opts: { fetchAll?: boolean } = {}): Promise<Node[]> {
    const { nodes } = await paged(
      (number, size) =>
        this.http.get(routes.meetings(), { cacheTtlMs: LIVE_TTL, query: { event_id: eventId, ...pageQuery(number, size) } }),
      { page_number: 1, page_size: 100, fetch_all: opts.fetchAll ?? true },
      100,
    );
    return nodes;
  }

  async meetings(eventInput: string): Promise<{ event: EventModel; meetings: { node: Node; model: MeetingModel }[] }> {
    const ev = await this.event(eventInput);
    const [nodes, me] = await Promise.all([this.meetingNodes(ev.event_id ?? ev.slug), this.meWithAttendee(ev.slug)]);
    return { event: ev, meetings: nodes.map((node) => ({ node, model: mapMeeting(node, me, ev.slug, ev.timezone) })) };
  }

  async meetingNode(id: string, fresh = true): Promise<Node> {
    const doc = await this.http.get(routes.meeting(id), { cacheTtlMs: fresh ? undefined : LIVE_TTL, notFound: "MEETING_NOT_FOUND" });
    const n = doc.data[0];
    if (!n) throw new BrellaError("MEETING_NOT_FOUND", `Meeting ${id} not found for ${this.email}`);
    return n;
  }

  async meeting(id: string): Promise<{ node: Node; model: MeetingModel }> {
    const node = await this.meetingNode(id);
    const slug = pick<string>(node, "event.slug", "eventSlug") ?? null;
    let tz: string | null = null;
    let me: MeContext = await this.me();
    if (slug) {
      try {
        tz = (await this.event(slug)).timezone;
        me = await this.meWithAttendee(slug);
      } catch {
        /* event lookup is best-effort */
      }
    }
    return { node, model: mapMeeting(node, me, slug, tz) };
  }

  async attendeeNode(slug: string, attendeeId: string): Promise<Node> {
    const doc = await this.http.get(routes.attendee(slug, attendeeId), { cacheTtlMs: CATALOG_TTL, notFound: "ATTENDEE_NOT_FOUND" });
    const n = doc.data[0];
    if (!n) throw new BrellaError("ATTENDEE_NOT_FOUND", `Attendee ${attendeeId} not found in ${slug}`);
    return n;
  }

  async userIdForAttendee(slug: string, attendeeId: string): Promise<string> {
    const n = await this.attendeeNode(slug, attendeeId);
    const uid = pick(n, "userId", "user.id");
    if (uid == null) throw new BrellaError("UPSTREAM_CHANGED", "Attendee payload has no user id; cannot address a meeting/chat to them");
    return String(uid);
  }

  /** Timeslots Brella suggests for meeting this attendee (optionally for rescheduling a meeting). */
  async suggestedSlots(slug: string, attendeeId: string, meetingId?: string): Promise<Node[]> {
    const doc = await this.http.get(routes.suggestedTimeslots(slug, attendeeId), {
      query: meetingId ? { meeting_id: meetingId } : undefined,
      cacheTtlMs: LIVE_TTL,
      notFound: "ATTENDEE_NOT_FOUND",
    });
    const nodes = collect(doc.data, "timeslot");
    return nodes.length ? nodes : doc.data;
  }

  async availability(slug: string, date?: string): Promise<Node[]> {
    const doc = await this.http.get(routes.networkingAvailability(slug, date), { cacheTtlMs: LIVE_TTL, notFound: "EVENT_NOT_FOUND" });
    const nodes = collect(doc.data, "timeslot");
    return nodes.length ? nodes : doc.data;
  }
}

/** Resolves the `account` tool argument and keeps one client per account. */
export class AccountRegistry {
  private readonly clients = new Map<string, AccountClient>();
  private readonly accounts = new Map<string, BrellaAccount>();

  constructor(
    readonly store: Store,
    readonly cfg: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * @param bound When the caller authenticated via OAuth, the Brella account its
   *   token belongs to; other accounts are invisible to it.
   */
  async resolve(account?: string, bound?: string): Promise<BrellaAccount> {
    let accounts = await this.store.listAccounts();
    if (bound) {
      accounts = accounts.filter((a) => a.email.toLowerCase() === bound.toLowerCase());
      if (!accounts.length) throw new BrellaError("SETUP_REQUIRED", "This connection's Brella account is no longer set up. Reconnect to sign in again.");
      accounts = accounts.map((a) => ({ ...a, is_default: true }));
    }
    let meta: AccountMeta | undefined;
    if (account) {
      const key = account.trim().toLowerCase();
      meta = accounts.find((a) => a.email.toLowerCase() === key || a.alias?.toLowerCase() === key);
      if (!meta) {
        throw new BrellaError("ACCOUNT_NOT_FOUND", `No configured account matches "${account}"`, {
          configured: accounts.map((a) => a.alias ?? a.email),
        });
      }
    } else {
      meta = accounts.find((a) => a.is_default) ?? accounts[0];
      if (!meta) throw new BrellaError("SETUP_REQUIRED", "No Brella account has been set up yet. Run setup to add one.");
    }
    const key = meta.email.toLowerCase();
    let client = this.clients.get(key);
    if (!client) {
      client = new AccountClient(meta.email, this.store, this.cfg, this.fetchImpl);
      this.clients.set(key, client);
    }
    const cached = this.accounts.get(key);
    if (cached && JSON.stringify(cached.meta) === JSON.stringify(meta)) return cached;
    const acct = new BrellaAccount(meta, client, this.cfg);
    this.accounts.set(key, acct);
    return acct;
  }
}
