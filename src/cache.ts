/** A small in-memory TTL cache that also merges identical calls that are still in flight. */
export class TtlCache {
  private store = new Map<string, { expires: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(private maxEntries = 5000) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = load()
      .then((value) => {
        if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string);
        this.store.set(key, { expires: Date.now() + ttlMs, value });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear() { this.store.clear(); }
}

/** Counts calls in a rolling hour so a shared upstream limit is never crossed. */
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
