import type { D1Like } from "./gold.js";

/**
 * Recipes for the crafting profit tool.
 *
 * Built-in: the common alchemy recipes, reagents from Classic 1.12 except where ForeverDB's Forever
 * levelling route shows a different one (marked "forever"). Every item id was checked against
 * ForeverDB's item list and house 114's auction listings on 2026-11-15; several elixirs carry
 * Forever names (Catseye Draught, Elixir of Greater Strength...) and Forever may have changed their
 * reagents too, so a built-in recipe is a baseline, not a fact.
 *
 * Saved: recipes players add with the crafting_recipe tool (kept in D1, shared by everyone on this
 * server). A saved recipe for the same item replaces the built-in one, which is how Forever-only
 * recipes (the new dyes) and corrected reagents get in.
 */

export interface Reagent { itemId: number; name: string; qty: number }
export interface Recipe {
  itemId: number; name: string; profession: string; skill?: number;
  /** How many one craft makes (default 1). */
  makes?: number;
  reagents: Reagent[];
  /** classic = Classic 1.12 reagents, forever = seen in Forever data, player = saved by a player. */
  from: "classic" | "forever" | "player";
  note?: string; savedBy?: string; savedAt?: string;
}

/** Bought from vendors at a fixed price, in copper (Forever prices from ForeverDB's alchemy route). */
export const VENDOR: Record<number, { name: string; copper: number }> = {
  3371: { name: "Empty Vial", copper: 4 },
  3372: { name: "Leaded Vial", copper: 40 },
  8925: { name: "Crystal Vial", copper: 500 },
};

const R = (itemId: number, name: string, qty = 1): Reagent => ({ itemId, name, qty });
const PEACE = R(2447, "Peacebloom"), SILVER = R(765, "Silverleaf"), EARTH = R(2449, "Earthroot"), MAGE = R(785, "Mageroyal");
const BRIAR = R(2450, "Briarthorn"), SWIFT = R(2452, "Swiftthistle"), BRUISE = R(2453, "Bruiseweed"), KELP = R(3820, "Stranglekelp");
const STEEL = R(3355, "Wild Steelbloom"), KINGS = R(3356, "Kingsblood"), LIFE = R(3357, "Liferoot"), FADE = R(3818, "Fadeleaf");
const GOLD = R(3821, "Goldthorn"), KHADGAR = R(3358, "Khadgar's Whisker"), SUN = R(8838, "Sungrass");
const EMPTY = R(3371, "Empty Vial"), LEADED = R(3372, "Leaded Vial"), CRYSTAL = R(8925, "Crystal Vial");
const x = (r: Reagent, qty: number): Reagent => ({ ...r, qty });

const A = (itemId: number, name: string, skill: number, reagents: Reagent[], from: Recipe["from"] = "classic", note?: string): Recipe =>
  ({ itemId, name, profession: "alchemy", skill, reagents, from, ...(note ? { note } : {}) });

export const BUILT_IN: Recipe[] = [
  A(118, "Minor Healing Potion", 1, [PEACE, SILVER, EMPTY]),
  A(5997, "Elixir of Minor Defense", 1, [SILVER, PEACE, EMPTY], "forever", "Forever recipe per ForeverDB's alchemy route (Classic used 2 Silverleaf)."),
  A(2454, "Elixir of Minor Strength", 1, [EARTH, SILVER, EMPTY], "classic", "Classic's Elixir of Lion's Strength, renamed in Forever."),
  A(2455, "Minor Mana Potion", 25, [MAGE, SILVER, EMPTY]),
  A(2458, "Elixir of Minor Fortitude", 50, [x(EARTH, 2), PEACE, EMPTY]),
  A(858, "Lesser Healing Potion", 55, [SILVER, BRIAR, EMPTY]),
  A(2457, "Elixir of Minor Agility", 50, [SWIFT, SILVER, EMPTY]),
  A(5631, "Rage Potion", 60, [R(5635, "Sharp Claw"), BRIAR, EMPTY], "forever"),
  A(6370, "Blackmouth Oil", 80, [x(R(6358, "Oily Blackmouth"), 2), EMPTY], "forever"),
  A(2459, "Swiftness Potion", 60, [SWIFT, BRIAR, EMPTY]),
  A(3383, "Elixir of Wisdom", 90, [MAGE, x(BRIAR, 2), EMPTY]),
  A(929, "Healing Potion", 110, [BRUISE, BRIAR, LEADED]),
  A(3385, "Lesser Mana Potion", 120, [MAGE, KELP, EMPTY]),
  A(6372, "Swim Speed Potion", 100, [SWIFT, R(6370, "Blackmouth Oil"), EMPTY], "forever"),
  A(6371, "Fire Oil", 130, [x(R(6359, "Firefin Snapper"), 2), EMPTY], "forever"),
  A(3391, "Elixir of Ogre Strength", 150, [EARTH, KINGS, LEADED]),
  A(5996, "Draught of Water Breathing", 90, [KELP, x(R(6370, "Blackmouth Oil"), 2), EMPTY], "classic", "Classic's Elixir of Water Breathing."),
  A(3825, "Elixir of Lesser Fortitude", 175, [STEEL, GOLD, LEADED], "classic", "Classic's Elixir of Fortitude."),
  A(1710, "Greater Healing Potion", 155, [LIFE, KINGS, LEADED]),
  A(3827, "Mana Potion", 160, [KELP, KINGS, LEADED]),
  A(6049, "Fire Protection Potion", 165, [R(4402, "Small Flame Sac"), R(6371, "Fire Oil"), LEADED], "forever"),
  A(8949, "Elixir of Agility", 185, [KELP, GOLD, LEADED]),
  A(10592, "Catseye Draught", 200, [GOLD, FADE, LEADED], "classic", "Classic's Catseye Elixir, renamed in Forever."),
  A(5634, "Free Action Potion", 150, [x(R(6370, "Blackmouth Oil"), 2), KELP, LEADED]),
  A(3824, "Shadow Oil", 165, [x(FADE, 4), x(R(3369, "Grave Moss"), 4), LEADED]),
  A(6149, "Greater Mana Potion", 205, [GOLD, KHADGAR, LEADED]),
  A(13423, "Stonescale Oil", 250, [R(13422, "Stonescale Eel"), LEADED], "forever"),
  A(3928, "Superior Healing Potion", 215, [SUN, KHADGAR, CRYSTAL]),
  A(13443, "Superior Mana Potion", 260, [x(SUN, 2), x(R(8839, "Blindweed"), 2), CRYSTAL]),
  A(13446, "Major Healing Potion", 275, [x(R(13464, "Golden Sansam"), 2), R(13465, "Mountain Silversage"), CRYSTAL]),
  A(13444, "Major Mana Potion", 295, [x(R(13463, "Dreamfoil"), 3), x(R(13467, "Icecap"), 2), CRYSTAL]),
  A(13452, "Elixir of the Mongoose", 280, [x(R(13465, "Mountain Silversage"), 2), x(R(13466, "Plaguebloom"), 2), CRYSTAL]),
  A(13454, "Greater Arcane Elixir", 285, [x(R(13463, "Dreamfoil"), 3), R(13465, "Mountain Silversage"), CRYSTAL]),
];

/** Item ids that count as a "dye" or "potion" group, for filters. */
export const isPotionName = (n: string) => /potion|elixir|flask|draught|oil\b/i.test(n);
export const isDyeName = (n: string) => /\bdye\b/i.test(n);

const SCHEMA = "CREATE TABLE IF NOT EXISTS recipes (item_id INTEGER PRIMARY KEY, body TEXT NOT NULL, saved_at TEXT NOT NULL)";

/** Built-in recipes plus the ones players saved (D1). */
export class RecipeBook {
  private ready?: Promise<unknown>;
  constructor(private db?: D1Like) {}

  private init() {
    if (!this.db) return Promise.resolve();
    this.ready ??= this.db.prepare(SCHEMA).run();
    return this.ready;
  }

  get canSave() { return Boolean(this.db); }

  async saved(): Promise<Recipe[]> {
    if (!this.db) return [];
    await this.init();
    const { results } = await this.db.prepare("SELECT body FROM recipes").all<{ body: string }>();
    return results.map((r) => JSON.parse(r.body) as Recipe);
  }

  /** Every recipe, a saved one replacing the built-in one for the same item. */
  async all(): Promise<Recipe[]> {
    const saved = await this.saved();
    const ids = new Set(saved.map((r) => r.itemId));
    return [...saved, ...BUILT_IN.filter((r) => !ids.has(r.itemId))];
  }

  async save(r: Recipe): Promise<void> {
    if (!this.db) throw new Error("Saving recipes needs the D1 database (bound as DB).");
    await this.init();
    const at = new Date().toISOString();
    await this.db.prepare("INSERT INTO recipes (item_id, body, saved_at) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET body = excluded.body, saved_at = excluded.saved_at")
      .bind(r.itemId, JSON.stringify({ ...r, from: "player", savedAt: at }), at).run();
  }

  async remove(itemId: number): Promise<boolean> {
    if (!this.db) return false;
    await this.init();
    const had = await this.db.prepare("SELECT item_id FROM recipes WHERE item_id = ?").bind(itemId).first();
    await this.db.prepare("DELETE FROM recipes WHERE item_id = ?").bind(itemId).run();
    return Boolean(had);
  }
}

// ───────────────────────── Pure maths ─────────────────────────

export interface UnitPrice { copper: number; how: "vendor" | "auction" | "crafted" | "yours" }

export interface CostLine { itemId: number; name: string; qty: number; unit?: number; how?: UnitPrice["how"]; total?: number }

/**
 * What one craft's reagents cost. `price` gives the auction price of an item (undefined = not listed).
 * An intermediate (Blackmouth Oil, Fire Oil...) costs the cheaper of buying it and crafting it, one level deep.
 * Vendor reagents use the vendor price unless the auction house is cheaper.
 */
export function reagentCost(recipe: Recipe, price: (id: number) => number | undefined, book: Map<number, Recipe>, own: Record<number, number> = {}, depth = 0): { copper?: number; lines: CostLine[]; missing: string[] } {
  const lines: CostLine[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const r of recipe.reagents) {
    const u = unitPrice(r.itemId, price, book, own, depth);
    if (!u) { missing.push(r.name); lines.push({ itemId: r.itemId, name: r.name, qty: r.qty }); continue; }
    total += u.copper * r.qty;
    lines.push({ itemId: r.itemId, name: r.name, qty: r.qty, unit: Math.round(u.copper), how: u.how, total: Math.round(u.copper * r.qty) });
  }
  return { copper: missing.length ? undefined : Math.round(total / (recipe.makes ?? 1)), lines, missing };
}

export function unitPrice(id: number, price: (id: number) => number | undefined, book: Map<number, Recipe>, own: Record<number, number> = {}, depth = 0): UnitPrice | undefined {
  if (own[id] !== undefined) return { copper: own[id], how: "yours" };
  const options: UnitPrice[] = [];
  const ah = price(id);
  if (ah !== undefined) options.push({ copper: ah, how: "auction" });
  if (VENDOR[id]) options.push({ copper: VENDOR[id].copper, how: "vendor" });
  const sub = depth < 1 ? book.get(id) : undefined;
  if (sub) { const c = reagentCost(sub, price, book, own, depth + 1).copper; if (c !== undefined) options.push({ copper: c, how: "crafted" }); }
  return options.sort((a, b) => a.copper - b.copper)[0];
}

export interface ProfitRow {
  itemId: number; name: string; profession: string; skill?: number; recipeFrom: Recipe["from"];
  cost?: number; sellPrice?: number; sellPriceFrom?: "7-day typical" | "listed now" | "yours";
  netAfterCut?: number; profit?: number; marginPct?: number;
  soldPerDay?: number; profitPerDay?: number; listedNow?: number;
  missing?: string[];
}

/** Profit of one craft and per day, given what the output sells for and how many sell a day. */
export function profitRow(recipe: Recipe, cost: { copper?: number; missing: string[] }, sell: { copper?: number; from?: ProfitRow["sellPriceFrom"] }, soldPerDay: number | undefined, share: number, cut: number, listedNow?: number): ProfitRow {
  const net = sell.copper !== undefined ? Math.round(sell.copper * (1 - cut)) : undefined;
  const profit = net !== undefined && cost.copper !== undefined ? net - cost.copper : undefined;
  return {
    itemId: recipe.itemId, name: recipe.name, profession: recipe.profession, skill: recipe.skill, recipeFrom: recipe.from,
    cost: cost.copper, sellPrice: sell.copper, sellPriceFrom: sell.from, netAfterCut: net, profit,
    marginPct: profit !== undefined && cost.copper ? Math.round((profit / cost.copper) * 100) : undefined,
    soldPerDay, profitPerDay: profit !== undefined && soldPerDay !== undefined ? Math.round(profit * soldPerDay * share) : undefined,
    listedNow, ...(cost.missing.length ? { missing: cost.missing } : {}),
  };
}
