import { TtlCache, HourlyBudget, HOUR, type KvLike } from "../cache.js";
import { normaliseStats, type Stats } from "../formulas/stats.js";

/**
 * Reads ForeverDB's public item pages when there is no API key. Their robots.txt allows /item/ and
 * /items and says its rules "don't restrict apps, addons or tools"; /api/ stays off limits without a
 * key. Their rule for showing the data is a visible credit link, which every answer carries.
 * Pages are cached for a day and requests are capped well under their API's 60 a minute.
 */
export const FOREVERDB_SITE = "https://foreverdb.net";

export interface SiteItem {
  itemId: number;
  name?: string;
  quality?: string;
  itemLevel?: number;
  requiredLevel?: number;
  slot?: string;
  armorType?: string;
  stats: Stats;
  /** Stat lines we couldn't map to a stat weight, e.g. "+5 Fire Resistance". */
  otherLines: string[];
  damage?: { min: number; max: number; school?: string; speed?: number };
  source?: string;
  build?: string;
  url: string;
}

export interface SiteListRow { itemId: number; name: string; itemLevel?: number }

const decode = (s: string) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** The page as lines of visible text. */
export function pageLines(html: string): string[] {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "\n").replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(li|p|div|h[1-6]|tr|dd|dt|section|header|ul|ol|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decode(body).split("\n").map((l) => l.replace(/\s+/g, " ").replace(/^[-•·]\s*/, "").trim()).filter(Boolean);
}

const QUALITY = /\b(Poor|Common|Uncommon|Rare|Epic|Legendary|Artifact|Heirloom)\b/;

export function parseItemPage(html: string, itemId: number, url: string): SiteItem {
  const lines = pageLines(html);
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "");
  const name = decode((h1 ?? ogTitle ?? "").replace(/\s*[-|–].*ForeverDB.*$/i, "").trim()) || undefined;

  const item: SiteItem = { itemId, name, stats: {}, otherLines: [], url };
  const raw: Record<string, number> = {};
  for (const l of lines) {
    let m: RegExpMatchArray | null;
    if (!item.quality && (m = l.match(/^(Poor|Common|Uncommon|Rare|Epic|Legendary)\b.*\(item level \d+/i))) item.quality = m[1];
    if ((m = l.match(/^Item level (\d+)$/i))) item.itemLevel = Number(m[1]);
    else if ((m = l.match(/^Requires level (\d+)$/i))) item.requiredLevel = Number(m[1]);
    else if ((m = l.match(/^Slot: ([^(]+?)(?: \(([^)]+)\))?$/i))) { item.slot = m[1].trim(); item.armorType = m[2]?.trim(); }
    else if ((m = l.match(/^([\d,]+) Armou?r$/i))) item.stats.armor = Number(m[1].replace(/,/g, ""));
    else if ((m = l.match(/^(\d+) - (\d+)(?: (\w+))? Damage,? speed ([\d.]+)$/i))) item.damage = { min: Number(m[1]), max: Number(m[2]), school: m[3], speed: Number(m[4]) };
    else if ((m = l.match(/^([\d.]+) damage per second$/i))) item.stats.weapon_dps = Number(m[1]);
    else if ((m = l.match(/^\+(\d+) (.+)$/))) {
      const n = normaliseStats({ [m[2]]: Number(m[1]) });
      if (Object.keys(n.stats).length) for (const [k, v] of Object.entries(n.stats)) raw[k] = (raw[k] ?? 0) + (v as number);
      else item.otherLines.push(l);
    } else if (!item.source && /^(Crafted with|Drops from|Sold by|Reward from|Quest reward)/i.test(l)) item.source = l;
    else if (!item.build && (m = l.match(/\bbuild (\d+\.\d+\.\d+\.\d+)/i))) item.build = m[1];
  }
  // The intro line, e.g. "Uncommon Cloth Legs armor piece (item level 28, requires level 23)", fills gaps.
  const intro = lines.find((l) => /\(item level \d+(, requires level \d+)?\)/i.test(l));
  if (intro) {
    item.quality ??= intro.match(QUALITY)?.[1];
    item.itemLevel ??= Number(intro.match(/item level (\d+)/i)?.[1]) || undefined;
    item.requiredLevel ??= Number(intro.match(/requires level (\d+)/i)?.[1]) || undefined;
  }
  Object.assign(item.stats, raw);
  return item;
}

/** Rows of an item list page: links to /item/{id} with the "(item level N)" that follows. */
export function parseItemList(html: string): SiteListRow[] {
  const rows: SiteListRow[] = [];
  const seen = new Set<number>();
  const re = /<a[^>]+href=["'](?:https?:\/\/foreverdb\.net)?\/item\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>([^<]{0,40})/gi;
  for (const m of html.matchAll(re)) {
    const id = Number(m[1]);
    const name = decode(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!name || seen.has(id)) continue;
    seen.add(id);
    rows.push({ itemId: id, name, itemLevel: Number(m[3].match(/item level (\d+)/i)?.[1]) || undefined });
  }
  return rows;
}

export class ForeverDbSiteError extends Error {}

export class ForeverDbSite {
  private cache: TtlCache;
  readonly budget: HourlyBudget;
  constructor(private base = FOREVERDB_SITE, kv?: KvLike, hourlyBudget = 600) {
    this.cache = new TtlCache(kv, "foreverdb-site:");
    this.budget = new HourlyBudget(hourlyBudget);
  }

  private async page(path: string): Promise<string> {
    if (!this.budget.take()) throw new ForeverDbSiteError("This server has read ForeverDB's site a lot this hour; try again later.");
    const res = await fetch(`${this.base}${path}`, { headers: { "user-agent": "forever-build-coach/0.3 (fan-made build helper; credits ForeverDB.net)", accept: "text/html" } });
    if (res.status === 404) throw new ForeverDbSiteError(`ForeverDB has no page at ${path}.`);
    if (res.status === 429) throw new ForeverDbSiteError("ForeverDB asked us to slow down; try again in a minute.");
    if (!res.ok) throw new ForeverDbSiteError(`ForeverDB answered ${res.status} for ${path}.`);
    return res.text();
  }

  item(itemId: number): Promise<SiteItem> {
    return this.cache.get(`item:${itemId}`, 24 * HOUR, async () => parseItemPage(await this.page(`/item/${itemId}`), itemId, `${this.base}/item/${itemId}`));
  }

  /** Every item's name, id and item level from the /items page, kept for a day. */
  index(): Promise<SiteListRow[]> {
    return this.cache.get("index", 24 * HOUR, async () => {
      const rows = parseItemList(await this.page("/items"));
      if (!rows.length) throw new ForeverDbSiteError("ForeverDB's item list didn't contain any items this server could read.");
      return rows;
    });
  }

  /** Items whose name contains every word of the query, exact matches first. */
  async search(query: string, limit = 10): Promise<{ hits: SiteListRow[]; indexed: number; sample: string[] }> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const q = query.toLowerCase().trim();
    const all = await this.index();
    const rows = all.filter((r) => { const n = r.name.toLowerCase(); return words.every((w) => n.includes(w)); });
    rows.sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || a.name.length - b.name.length);
    return { hits: rows.slice(0, limit), indexed: all.length, sample: all.slice(0, 5).map((r) => `${r.itemId} ${r.name}`) };
  }
}
