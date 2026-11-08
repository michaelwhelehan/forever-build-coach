/** The slice of Workers KV this server uses. Optional: without it, caching is per Worker instance. */
export interface KvLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Two-layer cache: memory in this Worker instance, then Workers KV shared by every instance.
 * Identical calls still in flight are merged.
 */
export class TtlCache {
  private store = new Map<string, { expires: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private kv?: KvLike, private prefix = "c:", private maxEntries = 2000) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = (async () => {
      const kvKey = this.prefix + key.slice(0, 480);
      if (this.kv) {
        const shared = (await this.kv.get(kvKey, "json").catch(() => null)) as { expires: number; value: T } | null;
        if (shared && shared.expires > Date.now()) { this.remember(key, shared.expires, shared.value); return shared.value; }
      }
      const value = await load();
      const expires = Date.now() + ttlMs;
      this.remember(key, expires, value);
      // KV needs a TTL of at least 60 seconds.
      if (this.kv) await this.kv.put(kvKey, JSON.stringify({ expires, value }), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) }).catch(() => undefined);
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private remember(key: string, expires: number, value: unknown) {
    if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string);
    this.store.set(key, { expires, value });
  }
}

/** Counts calls in a rolling hour (per Worker instance) as a brake on bursts. */
export class HourlyBudget {
  private calls: number[] = [];
  constructor(public limit: number) {}
  private prune() { const cutoff = Date.now() - 3600_000; while (this.calls.length && this.calls[0] < cutoff) this.calls.shift(); }
  take(n = 1): boolean {
    this.prune();
    if (this.calls.length + n > this.limit) return false;
    for (let i = 0; i < n; i++) this.calls.push(Date.now());
    return true;
  }
  remaining() { this.prune(); return this.limit - this.calls.length; }
  resetInMinutes() { this.prune(); return this.calls.length ? Math.ceil((this.calls[0] + 3600_000 - Date.now()) / 60_000) : 0; }
}

export const HOUR = 3600_000;
