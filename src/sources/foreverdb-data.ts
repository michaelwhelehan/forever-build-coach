import type { KvLike } from "../cache.js";
import { scoreStats, type Stats, type StatKey } from "../formulas/stats.js";

/**
 * ForeverDB's item catalogue: the items.json file their site loads, with every item's stats from
 * the Forever client. Kept in Workers KV (never in this repo: it's ForeverDB's data) and loaded
 * once per Worker instance. Filled either from FOREVERDB_ITEMS_URL (refreshed daily) or by
 * uploading the file to /admin/items.
 */
export const CATALOG_KEY = "foreverdb-data:items";
const DAY = 86_400_000;

/** One row of items.json, in ForeverDB's short field names. */
export interface Row {
  id: number; n: string; q: number; il: number; rl: number; c: number; sc: number; inv: number;
  st?: [number, number][]; ar?: number; dmg?: [number, number, number]; spd?: number;
  cls?: number; new?: unknown; chg?: Record<string, unknown>; set?: unknown; b?: number; spec?: string[];
}

const QUALITY = ["Poor", "Common", "Uncommon", "Rare", "Epic", "Legendary", "Artifact", "Heirloom"];
const SLOT: Record<number, string> = {
  1: "Head", 2: "Neck", 3: "Shoulder", 4: "Shirt", 5: "Chest", 6: "Waist", 7: "Legs", 8: "Feet", 9: "Wrist", 10: "Hands",
  11: "Finger", 12: "Trinket", 13: "One-Hand", 14: "Off Hand (shield)", 15: "Ranged", 16: "Back", 17: "Two-Hand", 18: "Bag",
  19: "Tabard", 20: "Chest", 21: "Main Hand", 22: "Off Hand", 23: "Held In Off-hand", 24: "Ammo", 25: "Thrown", 26: "Ranged", 28: "Relic",
};
/** Slot names people type, to the inventory types that fill that slot. */
const SLOT_QUERY: Record<string, number[]> = {
  head: [1], neck: [2], shoulder: [3], shoulders: [3], shirt: [4], chest: [5, 20], robe: [20], waist: [6], belt: [6], legs: [7],
  feet: [8], boots: [8], wrist: [9], wrists: [9], bracers: [9], hands: [10], gloves: [10], finger: [11], ring: [11], trinket: [12],
  back: [16], cloak: [16], main_hand: [13, 21, 17], mainhand: [13, 21, 17], weapon: [13, 21, 17], one_hand: [13, 21], two_hand: [17],
  off_hand: [14, 22, 23], offhand: [14, 22, 23], shield: [14], ranged: [15, 25, 26], wand: [26], relic: [28],
};
const WEAPON = ["One-Handed Axe", "Two-Handed Axe", "Bow", "Gun", "One-Handed Mace", "Two-Handed Mace", "Polearm", "One-Handed Sword", "Two-Handed Sword", "", "Staff", "", "", "Fist Weapon", "Miscellaneous", "Dagger", "Thrown", "", "Crossbow", "Wand", "Fishing Pole"];
const ARMOR = ["Miscellaneous", "Cloth", "Leather", "Mail", "Plate", "", "Shield", "Libram", "Idol", "Totem"];

/** ForeverDB stat codes (WoW's item stat types) to our stat keys; school damage counts as spell power. */
const STAT: Record<number, { key?: StatKey; label: string }> = {
  3: { key: "agi", label: "Agility" }, 4: { key: "str", label: "Strength" }, 5: { key: "int", label: "Intellect" },
  6: { key: "spi", label: "Spirit" }, 7: { key: "sta", label: "Stamina" }, 12: { key: "def", label: "Defense" },
  13: { key: "dodge", label: "Dodge" }, 14: { key: "dodge", label: "Parry" }, 15: { key: "block", label: "Block" },
  31: { key: "hit", label: "Hit" }, 32: { key: "crit", label: "Critical Strike" }, 38: { key: "ap", label: "Attack Power" },
  39: { key: "rap", label: "Ranged Attack Power" }, 41: { key: "heal", label: "Healing" }, 42: { key: "sp", label: "Spell Damage" },
  43: { key: "mp5", label: "Mana per 5 sec" }, 45: { key: "sp", label: "Spell Power" }, 48: { key: "block", label: "Block Value" },
  46: { label: "Health per 5 sec" }, 47: { label: "Spell Penetration" }, 36: { label: "Haste" }, 37: { label: "Expertise" },
  51: { label: "Fire Resistance" }, 52: { label: "Frost Resistance" }, 53: { label: "Holy Resistance" }, 54: { label: "Shadow Resistance" },
  55: { label: "Nature Resistance" }, 56: { label: "Arcane Resistance" },
  84: { key: "sp", label: "Holy Damage" }, 85: { key: "sp", label: "Fire Damage" }, 86: { key: "sp", label: "Nature Damage" },
  87: { key: "sp", label: "Frost Damage" }, 88: { key: "sp", label: "Shadow Damage" }, 89: { key: "sp", label: "Arcane Damage" },
};
const SCHOOL_CODES: Record<number, string> = { 84: "holy", 85: "fire", 86: "nature", 87: "frost", 88: "shadow", 89: "arcane" };
/** Which school a spec casts, so other schools' bonus damage isn't counted for it. */
const SPEC_SCHOOL: Record<string, string[]> = {
  "mage/frost": ["frost"], "mage/fire": ["fire"], "mage/arcane": ["arcane", "fire", "frost"],
  "warlock/affliction": ["shadow"], "warlock/demonology": ["shadow"], "warlock/destruction": ["shadow", "fire"],
  "priest/shadow": ["shadow"], "druid/balance": ["nature", "arcane"], "shaman/elemental": ["nature", "fire", "frost"],
  "paladin/holy": ["holy"], "priest/holy": ["holy"], "priest/discipline": ["holy"],
};

/** Classic 1.12 armour and weapon skills per class (a baseline: Forever may differ). Index into ARMOR / WEAPON. */
const CAN_USE: Record<string, { armor: number[]; weapons: number[] }> = {
  warrior: { armor: [0, 1, 2, 3, 4, 6], weapons: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 15, 16, 18] },
  paladin: { armor: [0, 1, 2, 3, 4, 6, 7], weapons: [0, 1, 4, 5, 6, 7, 8] },
  hunter: { armor: [0, 1, 2, 3], weapons: [0, 1, 2, 3, 6, 7, 8, 10, 13, 15, 16, 18] },
  rogue: { armor: [0, 1, 2], weapons: [2, 3, 4, 7, 13, 15, 16, 18] },
  priest: { armor: [0, 1], weapons: [4, 10, 15, 19] },
  shaman: { armor: [0, 1, 2, 3, 6, 9], weapons: [0, 1, 4, 5, 10, 13, 15] },
  mage: { armor: [0, 1], weapons: [7, 10, 15, 19] },
  warlock: { armor: [0, 1], weapons: [7, 10, 15, 19] },
  druid: { armor: [0, 1, 2, 8], weapons: [4, 5, 10, 13, 15] },
};
const CLASS_BIT: Record<string, number> = { warrior: 1, paladin: 2, hunter: 4, rogue: 8, priest: 16, shaman: 64, mage: 128, warlock: 256, druid: 1024 };

export interface CatalogItem {
  itemId: number; name: string; quality: string; itemLevel: number; requiredLevel: number;
  type: string; slot?: string; stats: Stats; statLines: string[];
  damage?: { min: number; max: number; speed: number }; newInForever?: boolean; changedFromClassic?: boolean; url: string;
}

export function slotName(r: Row) { return SLOT[r.inv]; }

export function rowToItem(r: Row): CatalogItem {
  const stats: Stats = {};
  const statLines: string[] = [];
  for (const [code, value] of r.st ?? []) {
    const s = STAT[code];
    statLines.push(`${value > 0 ? "+" : ""}${value} ${s?.label ?? `stat ${code}`}`);
    if (s?.key) stats[s.key] = (stats[s.key] ?? 0) + value;
  }
  if (r.ar) stats.armor = r.ar;
  let damage: CatalogItem["damage"];
  if (r.dmg && r.spd) {
    damage = { min: r.dmg[0], max: r.dmg[1], speed: r.spd / 1000 };
    stats.weapon_dps = Math.round(((r.dmg[0] + r.dmg[1]) / 2 / (r.spd / 1000)) * 10) / 10;
  }
  const type = r.c === 2 ? WEAPON[r.sc] || "Weapon" : r.c === 4 ? ARMOR[r.sc] || "Armor" : "Other";
  return {
    itemId: r.id, name: r.n, quality: QUALITY[r.q] ?? String(r.q), itemLevel: r.il, requiredLevel: r.rl, type, slot: slotName(r),
    stats, statLines, ...(damage ? { damage } : {}),
    ...(r.new ? { newInForever: true } : {}), ...(r.chg ? { changedFromClassic: true } : {}),
    url: `https://foreverdb.net/item/${r.id}`,
  };
}

/** Stats a spec actually benefits from: other schools' bonus damage is dropped. */
export function statsForSpec(r: Row, cls?: string, spec?: string): Stats {
  const schools = cls && spec ? SPEC_SCHOOL[`${cls}/${spec.toLowerCase()}`] : undefined;
  if (!schools) return rowToItem(r).stats;
  const filtered: Row = { ...r, st: (r.st ?? []).filter(([code]) => !SCHOOL_CODES[code] || schools.includes(SCHOOL_CODES[code])) };
  return rowToItem(filtered).stats;
}

export function canUse(r: Row, cls: string): boolean {
  const c = cls.toLowerCase();
  if (r.cls && CLASS_BIT[c] && !(r.cls & CLASS_BIT[c])) return false;
  const skills = CAN_USE[c];
  if (!skills) return true;
  if (r.c === 4) return skills.armor.includes(r.sc);
  if (r.c === 2) return skills.weapons.includes(r.sc);
  return true;
}

export interface FindOptions {
  name?: string; slot?: string; type?: string; minLevel?: number; maxLevel?: number; minQuality?: number;
  forClass?: string; spec?: string; weights?: Stats; limit?: number;
}

export class ItemCatalog {
  private rows?: Row[];
  private byId?: Map<number, Row>;
  private loadedAt = 0;
  private loading?: Promise<Row[] | undefined>;
  constructor(private kv?: KvLike, private url?: string) {}

  /** The rows, from memory, then KV, then the source URL. Undefined when there's no catalogue yet. */
  async load(): Promise<Row[] | undefined> {
    if (this.rows && Date.now() - this.loadedAt < DAY) return this.rows;
    this.loading ??= (async () => {
      let stored = this.kv ? ((await this.kv.get(CATALOG_KEY, "json").catch(() => null)) as { at: number; rows: Row[] } | null) : null;
      if ((!stored || Date.now() - stored.at > DAY) && this.url) {
        const fresh = await this.fetchRows().catch(() => undefined);
        if (fresh) { stored = { at: Date.now(), rows: fresh }; await this.save(fresh); }
      }
      if (stored?.rows?.length) this.set(stored.rows);
      return this.rows;
    })().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async fetchRows(): Promise<Row[]> {
    const res = await fetch(this.url!, { headers: { "user-agent": "forever-build-coach/0.4 (fan-made build helper; credits ForeverDB.net)", accept: "application/json" } });
    if (!res.ok) throw new Error(`ForeverDB items file answered ${res.status}`);
    return validateRows(await res.json());
  }

  private set(rows: Row[]) {
    this.rows = rows;
    this.byId = new Map(rows.map((r) => [r.id, r]));
    this.loadedAt = Date.now();
  }

  /** Store a new catalogue (from an upload or the source URL). */
  async save(rows: Row[]) {
    this.set(rows);
    if (this.kv) await this.kv.put(CATALOG_KEY, JSON.stringify({ at: Date.now(), rows }));
  }

  async get(id: number): Promise<Row | undefined> {
    await this.load();
    return this.byId?.get(id);
  }

  async find(o: FindOptions): Promise<{ total: number; items: (CatalogItem & { score?: number })[] } | undefined> {
    const rows = await this.load();
    if (!rows) return undefined;
    const words = (o.name ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const slots = o.slot ? SLOT_QUERY[o.slot.toLowerCase().replace(/[\s-]+/g, "_")] : undefined;
    const type = o.type?.toLowerCase();
    const q = (o.name ?? "").toLowerCase().trim();
    const hits = rows.filter((r) =>
      !r.spec?.includes("old") && !/^OLD/.test(r.n)
      && words.every((w) => r.n.toLowerCase().includes(w))
      && (!slots || slots.includes(r.inv))
      && (!type || (r.c === 2 ? WEAPON[r.sc] : r.c === 4 ? ARMOR[r.sc] : "").toLowerCase().includes(type))
      && (o.minLevel === undefined || r.rl >= o.minLevel)
      && (o.maxLevel === undefined || r.rl <= o.maxLevel)
      && (o.minQuality === undefined || r.q >= o.minQuality)
      && (!o.forClass || canUse(r, o.forClass)));
    let items: (CatalogItem & { score?: number })[];
    if (o.weights) {
      items = hits.map((r) => ({ ...rowToItem(r), score: Math.round(scoreStats(statsForSpec(r, o.forClass, o.spec), o.weights!).score * 10) / 10 }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.itemLevel - a.itemLevel);
    } else {
      items = hits.map(rowToItem).sort((a, b) => Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || a.name.length - b.name.length);
    }
    return { total: hits.length, items: items.slice(0, o.limit ?? 10) };
  }
}

/** Check an uploaded or fetched items file looks like ForeverDB's, and keep only rows we can use. */
export function validateRows(data: unknown): Row[] {
  if (!Array.isArray(data)) throw new Error("The items file should be a JSON array.");
  const rows = data.filter((r): r is Row => Boolean(r) && typeof r === "object" && typeof (r as Row).id === "number" && typeof (r as Row).n === "string");
  if (rows.length < 1000) throw new Error(`The items file has only ${rows.length} items; expected ForeverDB's full list (20,000+).`);
  return rows;
}
