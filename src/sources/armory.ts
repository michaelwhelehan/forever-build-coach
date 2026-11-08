import { normaliseStats, type Stats } from "../formulas/stats.js";
import type { Region } from "./blizzard.js";

/**
 * Fallback for when no Battle.net API key is set: read the public Forever armory page.
 * The page's meta description always carries level, race, class and item level. Gear is read
 * from any JSON state the page embeds, if it embeds one; Blizzard can change the page at any time.
 */
export const armoryUrl = (region: Region, name: string, surname: string) =>
  `https://worldofwarcraft.blizzard.com/en-us/forever/${region}/armory/character/${encodeURIComponent(`${name}-${surname}`.toLowerCase().replace(/\s+/g, "-"))}`;

export interface ArmoryGear { slot?: string; itemId?: number; name?: string; quality?: string; level?: number; stats: Stats }

export interface ArmoryCharacter {
  url: string;
  title?: string;
  level?: number;
  race?: string;
  class?: string;
  averageItemLevel?: number;
  equipped: ArmoryGear[];
  /** Where the gear came from, or why there is none. */
  gearSource: string;
  embeddedStateFound: boolean;
  /** Outline of the page's embedded data and URLs in it, to find where gear lives when parsing fails. */
  debug?: { gearListSizes?: number[]; stateShapes: unknown[]; urls: string[]; requests?: string[]; domItems?: string[] };
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return content === undefined ? undefined : decode(content);
}

/** "Uzal - 15 Undead Warrior, 7 ilvl" (class can come through as an unfilled "character.class"). */
export function parseDescription(desc: string): Pick<ArmoryCharacter, "level" | "race" | "class" | "averageItemLevel"> {
  const m = desc.match(/^.+? - (\d+) (.+) (\S+), (\d+) ilvl/i);
  if (!m) return {};
  const cls = m[3];
  return {
    level: Number(m[1]),
    race: m[2],
    class: /^character\./i.test(cls) ? undefined : cls,
    averageItemLevel: Number(m[4]),
  };
}

/** Pull a balanced {...} starting at index `start` (which must be "{"), honouring strings. */
function balancedObject(s: string, start: number): string | undefined {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return undefined;
}

/** Every JSON object the page embeds in a script: assigned variables, Next.js data, or JSON script tags. */
export function embeddedStates(html: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (txt: string | undefined) => { if (!txt) return; try { out.push(JSON.parse(txt)); } catch { /* not JSON */ } };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi)) tryParse(m[1].trim());
  for (const m of html.matchAll(/(?:var|let|const|window\.)\s*([A-Za-z_$][\w$]*)\s*=\s*\(?\s*\{/g)) {
    const brace = html.indexOf("{", m.index! + m[0].length - 1);
    tryParse(balancedObject(html, brace));
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === "string" ? v : isObj(v) ? str(v.name ?? v.type ?? v.slug) : undefined;

const SLOT_KEYS = ["slot", "inventoryType", "inventory_type", "slotType", "slot_type", "itemSlot", "equipmentSlot", "slotName", "slotId"];
const ITEM_KEYS = ["item", "id", "itemId", "item_id", "name", "itemName"];
/** Slot names as Blizzard writes them in various APIs (HEAD, MAIN_HAND, mainHand, head…). */
const SLOT_NAME = /^(head|neck|shoulders?|shirt|chest|robe|waist|belt|legs|feet|boots|wrists?|hands|gloves|finger_?[12]?|ring_?[12]?|trinket_?[12]?|back|cloak|main_?hand|off_?hand|two_?hand|ranged|relic|tabard|ammo)$/i;

const hasAny = (o: Record<string, unknown>, keys: string[]) => keys.some((k) => k in o);

/** Find lists that look like equipped items anywhere in a JSON tree: arrays of slot rows, or objects keyed by slot. */
function findGearArrays(node: unknown, depth = 0): Record<string, unknown>[][] {
  if (depth > 14 || !node || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    const looksLikeGear = node.length > 0 && node.every((e) => isObj(e) && hasAny(e, SLOT_KEYS) && hasAny(e, ITEM_KEYS));
    return looksLikeGear ? [node as Record<string, unknown>[]] : node.flatMap((e) => findGearArrays(e, depth + 1));
  }
  const entries = Object.entries(node);
  const slotted = entries.filter(([k, v]) => SLOT_NAME.test(k) && isObj(v) && hasAny(v, ITEM_KEYS));
  if (slotted.length >= 2) return [slotted.map(([k, v]) => ({ slot: k, ...(v as Record<string, unknown>) }))];
  return entries.flatMap(([, v]) => findGearArrays(v, depth + 1));
}

/** A short outline of a JSON tree (keys, array lengths, sample values), to see where a page keeps its data. */
export function shapeOf(node: unknown, depth = 0, maxDepth = 5): unknown {
  if (Array.isArray(node)) return node.length ? [`${node.length} ×`, shapeOf(node[0], depth + 1, maxDepth)] : [];
  if (isObj(node)) {
    if (depth >= maxDepth) return `{${Object.keys(node).slice(0, 12).join(", ")}}`;
    return Object.fromEntries(Object.entries(node).slice(0, 40).map(([k, v]) => [k, shapeOf(v, depth + 1, maxDepth)]));
  }
  if (typeof node === "string") return node.length > 60 ? `${node.slice(0, 60)}…` : node;
  return node;
}

/** Strings in a JSON tree that look like URLs or API paths. */
export function urlsIn(node: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 14 || out.size > 60) return out;
  if (typeof node === "string") { if (/^(https?:)?\/\/|^\/[\w-]+\//.test(node) && !/\.(png|jpe?g|gif|svg|webp|woff2?|css)(\?|$)/i.test(node)) out.add(node); }
  else if (node && typeof node === "object") for (const v of Object.values(node)) urlsIn(v, out, depth + 1);
  return out;
}

function findFirst(node: unknown, keys: string[], depth = 0): unknown {
  if (depth > 8 || !isObj(node)) return undefined;
  for (const k of keys) if (k in node) return node[k];
  for (const v of Object.values(node)) { const f = findFirst(v, keys, depth + 1); if (f !== undefined) return f; }
  return undefined;
}

function gearRow(e: Record<string, unknown>): ArmoryGear {
  const item = isObj(e.item) ? e.item : undefined;
  const stats = normaliseStats(e.stats ?? item?.stats ?? []).stats;
  const weapon = isObj(e.weapon) ? e.weapon : undefined;
  const dps = isObj(weapon?.dps) ? weapon!.dps.value : weapon?.dps ?? e.dps;
  if (typeof dps === "number") stats.weapon_dps = dps;
  const armor = isObj(e.armor) ? e.armor.value : e.armor;
  if (typeof armor === "number") stats.armor = armor;
  const level = isObj(e.level) ? e.level.value : e.itemLevel ?? e.item_level ?? e.level;
  const slotKey = SLOT_KEYS.find((k) => k in e);
  return {
    slot: slotKey ? str(e[slotKey]) ?? (typeof e[slotKey] === "number" ? String(e[slotKey]) : undefined) : undefined,
    itemId: Number(item?.id ?? e.itemId ?? e.item_id ?? e.id) || undefined,
    name: str(e.name) ?? str(e.itemName) ?? str(item?.name),
    quality: str(e.quality),
    level: typeof level === "number" ? level : undefined,
    stats,
  };
}

/** Gear and class from one JSON document (embedded state or a fetched response). */
/** Join gear lists (a page can split gear into columns, or keep weapons apart), one item per slot, bigger lists first. */
export function mergeGear(lists: ArmoryGear[][]): ArmoryGear[] {
  const out: ArmoryGear[] = [];
  const seen = new Set<string>();
  for (const list of [...lists].sort((a, b) => b.length - a.length)) {
    for (const g of list) {
      const key = g.slot ? `slot:${g.slot.toLowerCase().replace(/[\s_-]/g, "")}` : `item:${g.itemId ?? g.name}`;
      if (seen.has(key) || (g.itemId && seen.has(`id:${g.itemId}`) && !g.slot)) continue;
      seen.add(key);
      if (g.itemId) seen.add(`id:${g.itemId}`);
      out.push(g);
    }
  }
  return out;
}

export function gearFromJson(state: unknown): { equipped: ArmoryGear[]; class?: string; lists: number[] } {
  const arrays = findGearArrays(state);
  return {
    equipped: mergeGear(arrays.map((a) => a.map(gearRow))),
    lists: arrays.map((a) => a.length),
    class: str(findFirst(state, ["character_class", "class", "playableClass"])),
  };
}

export function parseArmoryPage(html: string, url: string): ArmoryCharacter {
  const desc = meta(html, "description") ?? meta(html, "og:description") ?? "";
  const title = meta(html, "og:title")?.replace(/ - Character - WoW$/i, "") ?? html.match(/<title>([^<]*)<\/title>/i)?.[1]?.replace(/ - Character$/i, "");
  const fromMeta = parseDescription(desc);
  const states = embeddedStates(html);
  const lists: ArmoryGear[][] = [];
  const listSizes: number[] = [];
  let cls = fromMeta.class;
  for (const st of states) {
    const g = gearFromJson(st);
    if (g.equipped.length) lists.push(g.equipped);
    listSizes.push(...g.lists);
    cls = cls ?? g.class;
  }
  const equipped = mergeGear(lists);
  return {
    url, title: title ? decode(title) : undefined, ...fromMeta, class: cls,
    equipped,
    gearSource: equipped.length ? "embedded page data" : states.length ? "page data found, but no equipment in it" : "no gear on the page (it loads gear in the browser)",
    embeddedStateFound: states.length > 0,
    debug: { gearListSizes: listSizes, stateShapes: states.map((st) => shapeOf(st)), urls: [...urlsIn(states)].slice(0, 60) },
  };
}

export class ArmoryError extends Error {}

export async function fetchArmory(region: Region, name: string, surname: string): Promise<ArmoryCharacter> {
  const url = armoryUrl(region, name, surname);
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; forever-build-coach/0.2)", accept: "text/html" }, redirect: "follow" });
  if (res.status === 404) throw new ArmoryError("The armory has no page for that character. It must be level 10+, have logged out once, and be written as first name and surname.");
  if (!res.ok) throw new ArmoryError(`The armory page answered ${res.status}.`);
  const parsed = parseArmoryPage(await res.text(), url);
  if (parsed.level === undefined && !parsed.equipped.length) throw new ArmoryError("The armory page loaded but had no character data in it.");
  return parsed;
}
