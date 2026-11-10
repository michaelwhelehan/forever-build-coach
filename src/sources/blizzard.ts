import { TtlCache } from "../cache.js";

export const BLIZZARD_CREDIT = "Character data from the Blizzard Battle.net API. World of Warcraft is a trademark of Blizzard Entertainment.";

export type Region = "us" | "eu" | "kr" | "tw";

export class BlizzardError extends Error {}

export class Blizzard {
  private token?: { value: string; expires: number };
  private cache = new TtlCache();
  constructor(private id?: string, private secret?: string) {}

  get enabled() { return Boolean(this.id && this.secret); }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await fetch("https://oauth.battle.net/token", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${this.id}:${this.secret}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new BlizzardError(`Battle.net login failed (${res.status}). Check BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET.`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  async get(region: Region, path: string, namespace: "profile" | "static" | "dynamic", ttlMs = 10 * 60_000): Promise<Record<string, unknown>> {
    if (!this.enabled) throw new BlizzardError("Blizzard API is not set up on this server (no BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET). Create a free client at https://develop.battle.net/access/clients.");
    const url = new URL(`https://${region}.api.blizzard.com${path}`);
    url.searchParams.set("namespace", `${namespace}-forever-${region}`);
    url.searchParams.set("locale", "en_US");
    return this.cache.get(url.toString(), ttlMs, async () => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
      if (res.status === 404) throw new BlizzardError("Blizzard has no record of that. Forever characters only show up from level 10, after logging out, and the name must be written as first and last name.");
      if (!res.ok) throw new BlizzardError(`Blizzard API answered ${res.status}.`);
      return (await res.json()) as Record<string, unknown>;
    });
  }

  /** Uncached read, for big answers like auction house dumps that are summarised by the caller. */
  async raw(region: Region, path: string, namespace: "profile" | "static" | "dynamic"): Promise<Record<string, unknown>> {
    if (!this.enabled) throw new BlizzardError("Blizzard API is not set up on this server (no BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET).");
    const url = new URL(`https://${region}.api.blizzard.com${path}`);
    url.searchParams.set("namespace", `${namespace}-forever-${region}`);
    url.searchParams.set("locale", "en_US");
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new BlizzardError(`Blizzard API answered ${res.status} for ${path}.`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Forever characters have a first name and a surname instead of a realm. */
  static slug(name: string, surname: string) {
    return `${name}-${surname}`.toLowerCase().normalize("NFC").replace(/\s+/g, "-");
  }

  async character(region: Region, name: string, surname: string) {
    const slug = encodeURIComponent(Blizzard.slug(name, surname));
    const [profile, equipment] = await Promise.all([
      this.get(region, `/profile/wow/character/${slug}`, "profile"),
      this.get(region, `/profile/wow/character/${slug}/equipment`, "profile").catch(() => undefined),
    ]);
    const specs = await this.get(region, `/profile/wow/character/${slug}/specializations`, "profile").catch(() => undefined);
    return { profile, equipment, specs };
  }
}
