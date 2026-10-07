/**
 * JSON:API → plain objects. Brella's v4 API returns `data`/`included` with
 * dasherized attribute keys; we camelCase every key and inline relationships
 * from `included` (depth-limited to avoid cycles).
 */

export type Node = Record<string, any> & { id?: string; type?: string };

export function camel(key: string): string {
  return key.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

export function camelize(value: unknown): any {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[camel(k)] = camelize(v);
    return out;
  }
  return value;
}

interface Resource {
  id?: string | number;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: unknown }>;
  meta?: unknown;
}

function isResource(x: unknown): x is Resource {
  return !!x && typeof x === "object" && "type" in (x as object) && ("attributes" in (x as object) || "id" in (x as object));
}

export interface Document {
  data: Node[];
  single: boolean;
  meta: Record<string, any>;
  links: Record<string, any>;
  /** Every resource in data+included, by type, for lookups the tree misses. */
  index: Map<string, Node>;
}

/** Normalize singular type names, e.g. "timeslots" → "timeslot", "chat-message" → "chatMessage". */
export function normType(t: string | undefined): string {
  if (!t) return "";
  return camel(t).replace(/s$/, "");
}

export function deserialize(body: unknown, maxDepth = 3): Document {
  if (!body || typeof body !== "object") {
    return { data: [], single: false, meta: {}, links: {}, index: new Map() };
  }
  const b = body as Record<string, any>;
  const looksJsonApi = "data" in b && (Array.isArray(b.data) ? b.data.every((d: unknown) => isResource(d) || d === null) : isResource(b.data) || b.data === null);
  if (!looksJsonApi) {
    // Plain JSON (or an envelope we don't know): just camelCase it.
    const c = camelize(b);
    const data = Array.isArray(c.data) ? c.data : c.data ? [c.data] : [c];
    return { data, single: !Array.isArray(c.data), meta: c.meta ?? {}, links: c.links ?? {}, index: new Map() };
  }

  const raw = new Map<string, Resource>();
  const keyOf = (t: unknown, id: unknown) => `${normType(String(t))}:${String(id)}`;
  const all: Resource[] = [...(Array.isArray(b.data) ? b.data : b.data ? [b.data] : []), ...((b.included as Resource[]) ?? [])];
  for (const r of all) if (r && r.type != null && r.id != null) raw.set(keyOf(r.type, r.id), r);

  const build = (r: Resource, depth: number, seen: Set<string>): Node => {
    const node: Node = { id: r.id != null ? String(r.id) : undefined, type: normType(r.type) };
    for (const [k, v] of Object.entries(r.attributes ?? {})) node[camel(k)] = camelize(v);
    if (r.meta) node._meta = camelize(r.meta);
    for (const [rk, rel] of Object.entries(r.relationships ?? {})) {
      const name = camel(rk);
      const d = rel?.data;
      const resolve = (ref: any): Node | null => {
        if (!ref || ref.id == null) return null;
        const k = keyOf(ref.type, ref.id);
        const target = raw.get(k);
        if (!target || depth >= maxDepth || seen.has(k)) return { id: String(ref.id), type: normType(ref.type) };
        return build(target, depth + 1, new Set([...seen, k]));
      };
      if (Array.isArray(d)) node[name] = d.map(resolve).filter(Boolean);
      else if (d === null) node[name] = null;
      else if (d !== undefined) node[name] = resolve(d);
    }
    return node;
  };

  const index = new Map<string, Node>();
  for (const [k, r] of raw) index.set(k, build(r, 1, new Set([k])));
  const top = (Array.isArray(b.data) ? b.data : b.data ? [b.data] : []).filter(Boolean) as Resource[];
  const data = top.map((r) => build(r, 0, new Set([keyOf(r.type, r.id)])));
  return { data, single: !Array.isArray(b.data), meta: camelize(b.meta ?? {}), links: camelize(b.links ?? {}), index };
}

/** Depth-first walk collecting every node whose type matches. */
export function collect(root: unknown, type: string, out: Node[] = [], seen = new Set<unknown>()): Node[] {
  if (!root || typeof root !== "object" || seen.has(root)) return out;
  seen.add(root);
  if (Array.isArray(root)) {
    for (const x of root) collect(x, type, out, seen);
    return out;
  }
  const n = root as Node;
  if (n.type === type && n.id != null) out.push(n);
  for (const v of Object.values(n)) if (v && typeof v === "object") collect(v, type, out, seen);
  return out;
}

/** First defined value among candidate keys (already camelCased). */
export function pick<T = any>(obj: any, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = k.includes(".") ? k.split(".").reduce((o: any, p) => (o == null ? undefined : o[p]), obj) : obj[k];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return undefined;
}
