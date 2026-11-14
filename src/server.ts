import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kbText, kbFiles, sources, sourceRef } from "./kb.js";
import { Everloot, EVERLOOT_CREDIT } from "./sources/everloot.js";
import { ForeverDb, FOREVERDB_CREDIT, FOREVERDB_PATHS } from "./sources/foreverdb.js";
import type { ForeverDbSite } from "./sources/foreverdb-site.js";
import { rowToItem, statsForSpec, reqLevel, type ItemCatalog } from "./sources/foreverdb-data.js";
import { guideUrl, pickSections, professionGuideUrl, parseSkillSteps, stepsFrom, foreverdbGuideUrl, FOREVERDB_GUIDES, type Guides } from "./sources/guides.js";
import { parseExport, SLOT_FOR_SEARCH, EXPORT_SLOTS } from "./addon-export.js";
import { Blizzard, BLIZZARD_CREDIT } from "./sources/blizzard.js";
import { fetchArmory, armoryUrl } from "./sources/armory.js";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { agree, derived, single, type Confidence, type Evidence } from "./formulas/confidence.js";
import { normaliseStats, scoreStats, weightsFor, specsFor, STAT_KEYS, type Stats } from "./formulas/stats.js";
import * as xp from "./formulas/xp.js";
import { netAfterCut, formatCopper, AH_CUT } from "./formulas/gold.js";
import { AuctionPrices, GROUP_RULESETS, type Faction, type HouseInfo } from "./sources/auctions.js";
import type { GoldFinder } from "./sources/gold.js";
import { profile, belowUsual, sellThrough, type PriceHistory } from "./sources/price-history.js";

export const VERSION = "0.6.0";

const CLASSES = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"] as const;
const classEnum = z.enum(CLASSES);

export const INSTRUCTIONS = `Forever Build Coach helps players optimise World of Warcraft: Forever characters while levelling: gear choices, talents, levelling speed, professions and gold.

Rules for every answer (full text: kb_guide topic "rules"):
1. Cite the source of each game fact. Tool results carry a "sources" list; pass it on.
2. Repeat the confidence label (high / medium / low) for anything a recommendation depends on.
3. WoW: Forever is not Classic 1.12. Classic numbers are a baseline only and must be flagged.
4. Missing data is unknown, never zero.
5. Show the inputs when a recommendation rests on a formula (stat score, XP/hour, gold/hour).
6. Name every item as a link to its "url" (ForeverDB's page), e.g. [Woolen Boots](https://foreverdb.net/item/2583), so players can click through.

Good starting points: character_lookup (if the player gives name + surname), gear_upgrades (the in-game addon's FBC1 line, or character_lookup's gear), find_items, levelling_guide ("what next", "which talent"), profession_guide (what to craft next), gold_guide, talent_tree, levelling_plan, profession_cost. Use the optimize_build prompt for a full review.`;

export interface Deps { everloot: Everloot; foreverdb: ForeverDb; foreverdbSite?: ForeverDbSite; catalog?: ItemCatalog; guides?: Guides; blizzard: Blizzard; browser?: BrowserWorker; auctions?: AuctionPrices; gold?: GoldFinder; history?: PriceHistory }

type Src = { id: string; name: string; url: string; credit?: string };

/** ForeverDB's page for an item: every item the server returns carries one, for players to click. */
export const itemUrl = (id: unknown) => (typeof id === "number" && id > 0 ? `https://foreverdb.net/item/${id}` : undefined);
const withUrl = <T extends { itemId?: unknown }>(it: T): T & { url?: string } => ({ ...it, ...(itemUrl(it.itemId) ? { url: itemUrl(it.itemId) } : {}) });

function reply(body: Record<string, unknown> & { confidence?: Confidence; sources?: Src[]; notes?: string[] }) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

const everlootSrc = (url?: string): Src => ({ ...sourceRef("everloot"), ...(url ? { url } : {}), credit: EVERLOOT_CREDIT });
const foreverdbSrc = (): Src => ({ ...sourceRef("foreverdb"), credit: FOREVERDB_CREDIT });
const blizzardSrc = (): Src => ({ ...sourceRef("blizzard"), credit: BLIZZARD_CREDIT });

function ageDays(iso: unknown): number | undefined {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 86_400_000 : undefined;
}

/** Keep a debug blob small enough to read: whole if it fits, otherwise its JSON cut at `max` characters. */
function capJson(v: unknown, max: number): unknown {
  const txt = JSON.stringify(v);
  return txt.length <= max ? v : `${txt.slice(0, max)}… (cut)`;
}

/** Wrap a handler so source errors come back as readable tool errors instead of crashes. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof reply>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail((err as Error).message);
    }
  };
}

const statsShape = z.record(z.string(), z.number()).describe("Stats as name -> number, e.g. {\"Strength\": 7, \"Stamina\": 5, \"dps\": 12.4}. Any common stat name works.");

export function createServer(deps: Deps): McpServer {
  const { everloot, foreverdb, blizzard } = deps;
  const server = new McpServer(
    { name: "forever-build-coach", title: "Forever Build Coach", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  // ───────────────────────── Knowledge base ─────────────────────────

  server.registerTool("kb_guide", {
    title: "Knowledge base",
    description: "Read the shared knowledge base: evidence rules, the source register (what each data source is, its limits and trust level), and the formulas and stat weights this server uses. Call with topic 'rules' before giving advice if unsure how to cite or flag uncertainty.",
    inputSchema: { topic: z.enum(["rules", "sources", "formulas", "stat_weights", "xp", "status", "list"]).default("rules") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ topic }) => {
    switch (topic) {
      case "rules": return reply({ topic, text: kbText("rules.md") });
      case "sources": return reply({ topic, sources: sources() });
      case "formulas": return reply({ topic, text: kbText("formulas/README.md") });
      case "stat_weights": return reply({ topic, text: kbText("formulas/stat-weights.yaml") });
      case "xp": return reply({ topic, text: kbText("formulas/xp.yaml") });
      case "status": return reply({
        topic,
        version: VERSION,
        everloot: { connected: true, callsLeftThisHour: everloot.budget.remaining() },
        foreverdb: { enabled: foreverdb.enabled, publicPages: Boolean(deps.foreverdbSite), note: foreverdb.enabled ? undefined : "Item names and stats come from ForeverDB's public pages. Add FOREVERDB_API_KEY for class abilities, recipes and patch changes too." },
        blizzard: { enabled: blizzard.enabled, note: blizzard.enabled ? undefined : "Add BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET to read characters' equipped gear." },
      });
      default: return reply({ topic, files: kbFiles() });
    }
  });

  // ───────────────────────── Game data lookups ─────────────────────────

  server.registerTool("search_game", {
    title: "Search game data",
    description: "Search WoW: Forever items, NPCs, quests, zones, spells, races, instances and lore by name or keywords. Returns ids to use with item_lookup, compare_items and the everloot tool. Uses Everloot, plus ForeverDB items when a key is configured.",
    inputSchema: {
      query: z.string().min(1).max(500),
      kind: z.enum(["item", "npc", "object", "quest", "zone", "spell", "lore_page", "achievement", "faction", "quest_chain", "mount", "legacy_perk", "race", "instance"]).optional(),
      limit: z.number().int().min(1).max(25).default(8),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ query, kind, limit }) => {
    const srcs: Src[] = [];
    const notes = ["Hits marked as game-file data are unconfirmed in play until players report them."];
    const ev = await everloot.call("search_knowledge", { query, kind, version: "forever", limit });
    srcs.push(everlootSrc());
    let hits = (ev.structured?.hits as Record<string, unknown>[] | undefined) ?? [];
    if (!hits.length) {
      // Everloot's Forever index is thin (it has no item names yet), so widen to every version and say so.
      const wide = await everloot.call("search_knowledge", { query, limit }).catch(() => undefined);
      hits = (wide?.structured?.hits as Record<string, unknown>[] | undefined) ?? [];
      if (hits.length) notes.push("Nothing matched in Everloot's Forever data, so these hits come from every version. gameVersion 'lore' or 'classic' (often the 2023 Warcraft Wiki) is a Classic baseline, not confirmed for Forever (low confidence). A wiki page's extId is not an item id.");
    }
    let foreverdbItems: unknown;
    if (!kind || kind === "item") {
      if (foreverdb.enabled) {
        foreverdbItems = await foreverdb.get("items", { q: query, limit }).then((r) => r.data).catch((e: Error) => ({ error: e.message }));
        srcs.push(foreverdbSrc());
        notes.push("Item names are searched in ForeverDB (foreverdbItems).");
      } else if (deps.catalog && (await deps.catalog.load())) {
        const found = await deps.catalog.find({ name: query, limit });
        foreverdbItems = found?.items.map((i) => ({ itemId: i.itemId, name: i.name, quality: i.quality, itemLevel: i.itemLevel, requiredLevel: i.requiredLevel, type: i.type, slot: i.slot, url: i.url }));
        srcs.push(foreverdbSrc());
        notes.push(`Item names are searched in ForeverDB's item list (${found?.total ?? 0} matches; foreverdbItems). For upgrades by slot and level use find_items.`);
      } else if (deps.foreverdbSite) {
        const found = await deps.foreverdbSite.search(query, limit).catch((e: Error) => ({ error: e.message }));
        foreverdbItems = "error" in found ? found : found.hits;
        if (!("error" in found) && !found.hits.length) notes.push(`No name match. Without a key only ForeverDB's ${found.indexed} featured items can be searched by name (the full list loads from their API). If you know an item's id, item_lookup reads its page directly; a FOREVERDB_API_KEY unlocks full name search.`);
        srcs.push(foreverdbSrc());
        notes.push("Item names are searched in ForeverDB's public item list (foreverdbItems). Pass an itemId to item_lookup or compare_items for its stats.");
      } else notes.push("Everloot can't search items by name: it knows Forever items by id only.");
    }
    return reply({
      query,
      everlootHits: hits.length ? hits : ev.text,
      ...(foreverdbItems !== undefined ? { foreverdbItems } : {}),
      sources: srcs,
      notes,
    });
  }));

  server.registerTool("item_lookup", {
    title: "Item details",
    description: "Everything known about one item by id: stats (ForeverDB game files and Everloot player reports), where it drops and how often, with a confidence label. Use search_game first to find the id.",
    inputSchema: { itemId: z.number().int().positive() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ itemId }) => {
    const out = await fetchItem(deps, itemId);
    return reply(out);
  }));

  server.registerTool("find_items", {
    title: "Find items and upgrades",
    description: "Search every WoW: Forever item (ForeverDB's item list, Forever client data) by slot, type, required level, quality and name. Give class and spec to keep only gear that class can use and rank it with stat weights; give equippedItemId to see the gain over what's worn. Use with character_lookup to suggest upgrades per slot.",
    inputSchema: {
      slot: z.string().optional().describe("e.g. head, neck, shoulder, back, chest, wrist, hands, waist, legs, feet, finger, trinket, main_hand, two_hand, off_hand, ranged, wand."),
      type: z.string().optional().describe("Armour or weapon type, e.g. cloth, leather, staff, dagger, wand."),
      name: z.string().optional().describe("Words the name must contain."),
      minLevel: z.number().int().min(0).max(60).optional().describe("Lowest required level."),
      maxLevel: z.number().int().min(0).max(60).optional().describe("Highest required level, usually the character's level."),
      minQuality: z.enum(["poor", "common", "uncommon", "rare", "epic"]).optional(),
      class: classEnum.optional(),
      spec: z.string().optional().describe("Spec for stat weights, e.g. 'frost'. Needs class."),
      equippedItemId: z.number().int().positive().optional().describe("The item worn in that slot now, to show each result's gain over it."),
      limit: z.number().int().min(1).max(25).default(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async (a) => {
    if (!deps.catalog || !(await deps.catalog.load())) return fail("ForeverDB's item list isn't loaded on this server yet. Try again in a minute, or use search_game.");
    const weights = a.class && a.spec ? weightsFor(a.class, a.spec) : undefined;
    if (a.class && a.spec && !weights) return fail(`No weights for ${a.class}/${a.spec}. Known specs: ${specsFor(a.class).join(", ")}.`);
    const quality = a.minQuality ? ["poor", "common", "uncommon", "rare", "epic"].indexOf(a.minQuality) : undefined;
    const found = await deps.catalog.find({ slot: a.slot, type: a.type, name: a.name, minLevel: a.minLevel, maxLevel: a.maxLevel, minQuality: quality, forClass: a.class, spec: a.spec, weights, limit: a.limit });
    if (!found) return fail("ForeverDB's item list isn't loaded on this server yet.");
    let equipped: { itemId: number; name: string; score: number } | undefined;
    if (a.equippedItemId && weights) {
      const row = await deps.catalog.get(a.equippedItemId);
      if (row) equipped = { itemId: row.id, name: row.n, score: Math.round(scoreStats(statsForSpec(row, a.class, a.spec), weights).score * 10) / 10 };
    }
    const items = found.items.map((i) => ({
      ...i, ...(equipped && i.score !== undefined ? { gainOverEquipped: Math.round((i.score - equipped.score) * 10) / 10 } : {}),
    }));
    const evidence: Evidence[] = [{ tier: "game_files", note: "ForeverDB item list (Forever client data)" }];
    if (weights) evidence.push({ tier: "classic_baseline", note: "starter stat weights" });
    return reply({
      filters: { slot: a.slot, type: a.type, name: a.name, requiredLevel: [a.minLevel ?? 0, a.maxLevel ?? 60], minQuality: a.minQuality, class: a.class, spec: a.spec },
      matches: found.total,
      ...(weights ? { weightsUsed: weights } : {}),
      ...(equipped ? { equipped } : {}),
      items,
      confidence: weights ? derived(evidence, "stat-weight score (formula: sum of stat x weight)") : single(evidence[0]),
      sources: [foreverdbSrc(), ...(weights ? [{ ...sourceRef("classic_baseline"), url: "kb/formulas/stat-weights.yaml" }] : [])],
      notes: [
        "Stats are from the Forever client as ForeverDB lists them; where an item drops or who sells it is on its url, or via item_lookup.",
        ...(a.class ? ["Usable gear follows Classic 1.12 armour and weapon skills (low confidence for Forever)."] : []),
        ...(weights ? ["Scores use Classic-derived levelling weights (formula: sum of stat x weight); bonus damage of other spell schools isn't counted for this spec."] : []),
      ],
    });
  }));

  server.registerTool("gear_upgrades", {
    title: "Upgrades for my gear",
    description: "Best upgrades for every slot of a character's gear, from all WoW: Forever items, ranked by spec stat weights with the gain over what's worn. Give the line the in-game Forever Build Coach addon shows (/fbc, starts with FBC1:), or class, level and equipped item ids (e.g. from character_lookup).",
    inputSchema: {
      export: z.string().max(2000).optional().describe("The addon's line, starting with FBC1:"),
      class: classEnum.optional(),
      level: z.number().int().min(1).max(60).optional(),
      equipped: z.array(z.object({ slot: z.enum(EXPORT_SLOTS), itemId: z.number().int().min(0) })).max(17).optional().describe("Worn items by slot, 0 for empty."),
      spec: z.string().describe("Spec for stat weights, e.g. 'frost'."),
      levelsAhead: z.number().int().min(0).max(10).default(0).describe("Also show items up to this many levels above the character."),
      perSlot: z.number().int().min(1).max(5).default(3),
      slots: z.array(z.enum(EXPORT_SLOTS)).optional().describe("Only these slots."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async (a) => {
    let cls = a.class as string | undefined, level = a.level, name: string | undefined;
    const worn: Record<string, number> = {};
    if (a.export) {
      const ex = parseExport(a.export);
      cls = ex.class; level = ex.level; name = ex.name;
      Object.assign(worn, ex.slots);
    }
    for (const e of a.equipped ?? []) worn[e.slot] = e.itemId;
    if (!cls || !level) return fail("Give the addon's FBC1 line, or class and level.");
    if (!deps.catalog || !(await deps.catalog.load())) return fail("ForeverDB's item list isn't loaded on this server yet. Try again in a minute.");
    const weights = weightsFor(cls, a.spec);
    if (!weights) return fail(`No weights for ${cls}/${a.spec}. Known specs: ${specsFor(cls).join(", ")}.`);
    const catalog = deps.catalog;
    const scoreOf = async (id: number) => {
      const row = id ? await catalog.get(id) : undefined;
      return row ? { itemId: row.id, name: row.n, url: itemUrl(row.id), slot: rowToItem(row).slot, requiredLevel: reqLevel(row), score: Math.round(scoreStats(statsForSpec(row, cls, a.spec), weights).score * 10) / 10 } : undefined;
    };
    const mainHand = worn.MAINHAND ? await catalog.get(worn.MAINHAND) : undefined;
    const twoHanded = mainHand?.inv === 17;
    const wanted = (a.slots ?? EXPORT_SLOTS.filter((s) => s !== "OFFHAND" || !twoHanded)) as string[];
    const wornIds = new Set(Object.values(worn).filter(Boolean));
    const out = [];
    for (const slot of wanted) {
      const current = await scoreOf(worn[slot] ?? 0);
      const found = await catalog.find({ slot: SLOT_FOR_SEARCH[slot], maxLevel: level + a.levelsAhead, forClass: cls, spec: a.spec, weights, limit: 40 });
      const base = current?.score ?? 0;
      const upgrades = (found?.items ?? [])
        .filter((i) => !wornIds.has(i.itemId) && (i.score ?? 0) > base)
        .slice(0, a.perSlot)
        .map((i) => ({ name: i.name, url: i.url, itemId: i.itemId, requiredLevel: i.requiredLevel, quality: i.quality, type: i.type, score: i.score, gain: Math.round(((i.score ?? 0) - base) * 10) / 10, stats: i.statLines, ...(i.binds ? { binds: i.binds } : {}) }));
      out.push({ slot, equipped: current ?? (worn[slot] ? { itemId: worn[slot], url: itemUrl(worn[slot]), note: "not in ForeverDB's list" } : "empty"), upgrades });
    }
    out.sort((x, y) => (y.upgrades[0]?.gain ?? 0) - (x.upgrades[0]?.gain ?? 0));
    return reply({
      character: { name, class: cls, level, spec: a.spec },
      weightsUsed: weights,
      bySlot: out,
      confidence: derived([{ tier: "game_files", note: "ForeverDB item list (Forever client data)" }, { tier: "classic_baseline", note: "starter stat weights" }], "stat-weight score (formula: sum of stat x weight)"),
      sources: [foreverdbSrc(), { ...sourceRef("classic_baseline"), url: "kb/formulas/stat-weights.yaml" }],
      notes: [
        "Items that bind on pickup can't be bought on the auction house: the player must loot, earn or craft them (a crafted one needs its pattern, which may bind too). Say so for each.", "Slots are sorted by the biggest gain first. Where an item drops, who sells it or how it's crafted is on its url.",
        "Usable gear follows Classic 1.12 armour and weapon skills; scores use Classic-derived levelling weights (low confidence for Forever).",
        ...(twoHanded ? ["A two-handed weapon is worn, so off-hand upgrades are left out."] : []),
      ],
    });
  }));

  server.registerTool("levelling_guide", {
    title: "Levelling guide",
    description: "Answer from the Icy Veins WoW: Forever levelling guide for a class and spec (e.g. frost mage): what to do next, which talent to take, where to level, rotation. Returns the guide sections that match the question and the player's level, with the link. Read on request and cached for a day.",
    inputSchema: {
      class: classEnum,
      spec: z.string().optional().describe("e.g. 'frost'. Defaults to the class's first spec."),
      question: z.string().max(300).optional().describe("e.g. 'which talent next', 'where should I level', 'rotation'."),
      level: z.number().int().min(1).max(60).optional().describe("The character's level, to find the part of the guide for it."),
      list: z.boolean().default(false).describe("Only list the guide's section headings."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ class: cls, spec, question, level, list }) => {
    if (!deps.guides) return fail("Guides aren't set up on this server.");
    const url = guideUrl(cls, spec);
    const g = await deps.guides.get(url);
    const src = { id: "icy_veins", name: "Icy Veins: WoW Forever levelling guide", url, credit: "Guide by Icy Veins (https://www.icy-veins.com). Read the full guide there." };
    return reply({
      guide: g.title ?? url, url,
      ...(list ? { sections: g.sections.map((s) => s.heading) } : { matches: pickSections(g, question, level), otherSections: g.sections.map((s) => s.heading) }),
      confidence: single({ tier: "community_guide", note: `Icy Veins guide, read ${g.fetchedAt.slice(0, 10)}` }),
      sources: [src],
      notes: [
        "Quote only what answers the question and link the guide for the rest; the text is Icy Veins' work.",
        "Check talent advice against talent_tree: Forever's trees can change with patches.",
      ],
    });
  }));

  server.registerTool("profession_guide", {
    title: "Profession levelling guide",
    description: "What to craft next to level a profession (tailoring, enchanting, alchemy, ...), from ForeverDB's step-by-step WoW: Forever route: the skill range, recipe, how many to make, reagents, when to train, plus its shopping list. Give your current skill to get the next steps. Gathering professions (herbalism, mining, skinning) may have node maps instead.",
    inputSchema: {
      profession: z.string().min(3).max(40).describe("e.g. 'tailoring', 'enchanting', 'first aid'."),
      skill: z.number().int().min(1).max(375).optional().describe("Current skill, to start the route from there."),
      steps: z.number().int().min(1).max(12).default(4).describe("How many steps to return."),
      question: z.string().max(300).optional().describe("e.g. 'shopping list', 'trainer', 'best in slot'."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ profession, skill, steps: count, question }) => {
    if (!deps.guides) return fail("Guides aren't set up on this server.");
    const url = professionGuideUrl(profession);
    const g = await deps.guides.get(url);
    const route = parseSkillSteps(g);
    const next = stepsFrom(route, skill ?? 1, count);
    const src = { ...foreverdbSrc(), url };
    return reply({
      guide: g.title ?? url, url,
      fromSkill: skill ?? 1,
      nextSteps: next.map((s) => ({ skill: `${s.from}-${s.to}`, step: s.text })),
      routeSteps: route.length,
      ...(question || !route.length ? { matches: pickSections(g, question ?? profession, undefined, 2) } : {}),
      otherSections: g.sections.map((s) => s.heading),
      confidence: single({ tier: "community_guide", note: `ForeverDB's route (recipes from game files), read ${g.fetchedAt.slice(0, 10)}` }),
      sources: [src],
      notes: [
        route.length ? "Each step: craft until the end of its skill range; recipes go grey, so the counts are estimates." : "This page had no skill-range steps this server could read; the matching sections are below.",
        "The page shows the Alliance route by default; trainer locations can differ for Horde.",
        "Reagent prices: market_price (auction scans can be missing for Forever, so prices may be unknown).",
      ],
    });
  }));

  server.registerTool("gold_guide", {
    title: "Gold guide",
    description: "How to make gold in WoW: Forever: ForeverDB's guides on the auction house, what sells at low levels (cloth, leather, ore, herbs, meat, with where they drop), and which professions earn most by class. Returns the sections that answer the question, with the link. Pair with farm_value and market_price when prices exist.",
    inputSchema: {
      question: z.string().max(300).optional().describe("e.g. 'what sells at level 15', 'auction house cut', 'best farm for a mage'."),
      guide: z.enum(FOREVERDB_GUIDES).default("making-money").describe("making-money, professions, or best-professions-by-class."),
      level: z.number().int().min(1).max(60).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ question, guide, level }) => {
    if (!deps.guides) return fail("Guides aren't set up on this server.");
    const url = foreverdbGuideUrl(guide);
    const g = await deps.guides.get(url);
    return reply({
      guide: g.title ?? url, url,
      matches: pickSections(g, question, level),
      otherSections: g.sections.map((s) => s.heading),
      otherGuides: FOREVERDB_GUIDES.filter((x) => x !== guide).map(foreverdbGuideUrl),
      confidence: single({ tier: "community_guide", note: `ForeverDB guide, read ${g.fetchedAt.slice(0, 10)}` }),
      sources: [{ ...foreverdbSrc(), url }],
      notes: [
        "ForeverDB wrote the money guide before launch, so it has no real auction prices or gold-per-hour figures.",
        "For gold per hour, ask the player what they gather per hour and use farm_value; unknown prices stay unknown.",
      ],
    });
  }));

  server.registerTool("talent_tree", {
    title: "Talent trees",
    description: "A class's WoW: Forever talent trees from the game files: every talent, ranks, position, prerequisites, starter builds and the levels talent points arrive at. Use it to plan which talents to take as you level.",
    inputSchema: {
      class: classEnum,
      tree: z.string().optional().describe("Limit to one tree by name, e.g. 'Fury'."),
      builds: z.boolean().default(true).describe("Include starter builds."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async (args) => {
    const ev = await everloot.call("talent_tree", { class: args.class, tree: args.tree, builds: args.builds });
    const s = ev.structured ?? {};
    const srcs: Src[] = [everlootSrc(s.url as string | undefined)];
    let foreverdbClass: unknown;
    if (foreverdb.enabled) {
      foreverdbClass = await foreverdb.get(`classes/${args.class}`).then((r) => r.data).catch((e: Error) => ({ error: e.message }));
      srcs.push(foreverdbSrc());
    }
    return reply({
      ...(ev.structured ? { tree: s } : { text: ev.text }),
      ...(foreverdbClass !== undefined ? { foreverdbClass } : {}),
      confidence: single({ tier: "game_files", note: `build ${s.build ?? "unknown"}` }),
      sources: srcs,
      notes: ["Talent data is read from the game files. Blizzard can hotfix values; check patch_changes for recent buffs and nerfs."],
    });
  }));

  server.registerTool("talent_points_by_level", {
    title: "Talent points by level",
    description: "How many talent points a character has at each level, and the Legacy 'Talented' adjustment (first point earlier). Pure maths from the talent_tree pointLevels when available.",
    inputSchema: { class: classEnum, level: z.number().int().min(1).max(60), talentedRanks: z.number().int().min(0).max(5).default(0) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ class: cls, level, talentedRanks }) => {
    const ev = await everloot.call("talent_tree", { class: cls, builds: false });
    const points = (ev.structured?.points ?? {}) as { pointLevels?: number[]; firstPointLevel?: number; total?: number };
    const levels = points.pointLevels ?? Array.from({ length: 51 }, (_, i) => i + 10);
    // Talented: first point one level earlier per rank (beta description).
    const adjusted = levels.map((l, i) => (i === 0 ? Math.max(1, l - talentedRanks) : l));
    const have = adjusted.filter((l) => l <= level).length;
    const next = adjusted.find((l) => l > level);
    return reply({
      class: cls, level, pointsAvailable: have, nextPointAtLevel: next ?? null, totalAtCap: points.total ?? levels.length,
      confidence: points.pointLevels ? single({ tier: "game_files" }) : single({ tier: "classic_baseline", note: "Everloot gave no point levels; assumed one point per level from 10" }),
      sources: [everlootSrc(), ...(talentedRanks ? [{ ...sourceRef("warcraft_tavern_xp") }] : [])],
    });
  }));

  server.registerTool("class_races", {
    title: "Races for a class",
    description: "Which races can play a class in WoW: Forever, per faction, with racial traits from the game files. Good for 'which race is best for my class' questions.",
    inputSchema: { class: classEnum, faction: z.enum(["alliance", "horde"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async (args) => {
    const ev = await everloot.call("class_races", { class: args.class, faction: args.faction });
    return reply({
      ...(ev.structured ? { result: ev.structured } : { text: ev.text }),
      confidence: single({ tier: "game_files" }),
      sources: [everlootSrc(ev.structured?.url as string | undefined)],
    });
  }));

  server.registerTool("patch_changes", {
    title: "Recent buffs, nerfs and blue posts",
    description: "Recent WoW: Forever changes: class buffs and nerfs per build (ForeverDB, if configured) and Blizzard blue posts and hotfixes (Everloot). Check before recommending a build in case it was just changed.",
    inputSchema: { class: classEnum.optional(), limit: z.number().int().min(1).max(50).default(15) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ class: cls, limit }) => {
    const srcs: Src[] = [];
    const blue = await everloot.call("recent_changes", { filter: "all", game: "forever", limit }).catch((e: Error) => ({ text: e.message, structured: undefined }));
    srcs.push(everlootSrc());
    let buffsNerfs: unknown;
    if (foreverdb.enabled) {
      buffsNerfs = await foreverdb.get("buffs-nerfs", { class: cls, limit }, 30 * 60_000).then((r) => r.data).catch((e: Error) => ({ error: e.message }));
      srcs.push(foreverdbSrc());
    }
    return reply({
      officialChanges: blue.structured ?? blue.text,
      ...(buffsNerfs !== undefined ? { buffsNerfs } : { buffsNerfs: "Not available: this server has no ForeverDB key." }),
      confidence: single({ tier: "official" }),
      sources: srcs,
    });
  }));

  // ───────────────────────── Gear ─────────────────────────

  const itemInput = z.object({
    itemId: z.number().int().positive().optional(),
    label: z.string().optional().describe("A name for the item, used when giving stats by hand."),
    stats: statsShape.optional(),
    slot: z.string().optional().describe("e.g. 'main_hand', 'two_hand', 'ranged', 'chest'. Weapon DPS only counts for weapons."),
  });

  server.registerTool("compare_items", {
    title: "Compare gear",
    description: "Rank items for a class and spec using stat weights, and show why. Give item ids (stats are looked up) or stats by hand, or both. Also use it to check an upgrade: put the equipped item first. Weights default to levelling weights in kb/formulas/stat-weights.yaml (low confidence; pass your own to override).",
    inputSchema: {
      class: classEnum,
      spec: z.string().describe("Spec, e.g. 'fury', 'beast_mastery', 'frost', 'feral'."),
      items: z.array(itemInput).min(1).max(12),
      weights: statsShape.optional().describe("Override weights, e.g. {\"sta\": 1.2}. Merged over the defaults."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ class: cls, spec, items, weights }) => {
    const base = weightsFor(cls, spec);
    if (!base && !weights) return fail(`No weights for ${cls}/${spec}. Known specs: ${specsFor(cls).join(", ")}.`);
    const merged: Stats = { ...(base ?? {}), ...normaliseStats(weights ?? {}).stats };
    const evidence: Evidence[] = [weights ? { tier: "user_provided", note: "custom weights" } : { tier: "classic_baseline", note: "starter stat weights" }];
    const srcs = new Map<string, Src>();
    const results = [];
    for (const it of items) {
      let stats: Stats = {};
      let name = it.label;
      let itemConfidence: Confidence | undefined;
      const notes: string[] = [];
      if (it.itemId) {
        const found = await fetchItem(deps, it.itemId);
        stats = found.stats as Stats;
        name = name ?? (found.name as string | undefined);
        itemConfidence = found.confidence as Confidence;
        for (const s of found.sources as Src[]) srcs.set(s.id, s);
        if (found.statsFrom === "none") notes.push("No stats known for this item yet; pass them by hand.");
      }
      if (it.stats) {
        const n = normaliseStats(it.stats);
        stats = { ...stats, ...n.stats };
        if (n.unknown.length) notes.push(`Ignored unknown stats: ${n.unknown.join(", ")}`);
        itemConfidence = itemConfidence ?? single({ tier: "user_provided" });
      }
      const isWeapon = !it.slot || /main|two|2h|weapon|ranged|bow|gun|staff/i.test(it.slot);
      if (!isWeapon) delete stats.weapon_dps;
      const scored = scoreStats(stats, merged);
      if (itemConfidence) evidence.push({ tier: itemConfidence.score >= 0.8 ? "player_observed" : itemConfidence.score >= 0.6 ? "game_files" : "classic_baseline", reporters: 5 });
      results.push({ itemId: it.itemId, ...(itemUrl(it.itemId) ? { url: itemUrl(it.itemId) } : {}), name: name ?? `item ${results.length + 1}`, score: scored.score, breakdown: scored.breakdown, statsNotWeighted: scored.ignored, itemConfidence, notes });
    }
    const ranked = [...results].sort((a, b) => b.score - a.score);
    const first = results[0];
    return reply({
      class: cls, spec,
      weightsUsed: merged,
      ranking: ranked.map((r, i) => ({
        rank: i + 1, ...r,
        vsFirstListed: first && first.score ? `${r.score >= first.score ? "+" : ""}${Math.round(((r.score - first.score) / first.score) * 1000) / 10}%` : undefined,
      })),
      confidence: derived(evidence, "stat-weight score (formula: sum of stat x weight)"),
      sources: [...srcs.values(), { ...sourceRef("classic_baseline"), url: "kb/formulas/stat-weights.yaml" }],
      notes: [
        "Scores within about 5% of each other are a tie; pick on set bonuses, upcoming quest rewards or looks.",
        "Weights are Classic-derived levelling rules of thumb, not Forever-tested. Override them if your class plays differently.",
      ],
    });
  }));

  server.registerTool("character_lookup", {
    title: "Look up a character",
    description: "Read a WoW: Forever character: level, class, race, specs and equipped gear with stats, ready for compare_items. Uses Blizzard's API when the server has keys, otherwise the public Forever armory page (which may give only level, race and item level). Forever characters are named 'First Surname'; they appear from level 10, after logging out.",
    inputSchema: {
      name: z.string().min(1),
      surname: z.string().min(1),
      region: z.enum(["us", "eu", "kr", "tw"]).default("eu"),
      debug: z.boolean().default(false).describe("Also return an outline of the armory page's data and the requests it made. Turned on automatically when no gear is found."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ name, surname, region, debug }) => {
    let apiError: string | undefined;
    if (blizzard.enabled) {
      const viaApi = await blizzard.character(region, name, surname).catch((e: Error) => { apiError = e.message; return undefined; });
      if (viaApi) return characterFromApi(viaApi);
    }
    // No API key (or the API failed): read the public armory page instead, in a real browser when we have one,
    // because the page loads its gear with JavaScript.
    let page: Awaited<ReturnType<typeof fetchArmory>> & { renderedText?: string };
    let renderError: string | undefined;
    if (deps.browser) {
      const { renderArmory } = await import("./sources/browser.js");
      page = await renderArmory(deps.browser, armoryUrl(region, name, surname)).catch(async (e: Error) => {
        renderError = e.message;
        return fetchArmory(region, name, surname);
      });
    } else page = await fetchArmory(region, name, surname);
    const notes = [
      "Read from the public armory page because this server has no Battle.net API key" + (apiError ? ` (the API said: ${apiError})` : "") + ".",
      ...(renderError ? [`Opening the page in a browser failed (${renderError}), so only the plain page was read.`] : []),
      ...(!deps.browser ? ["Gear needs Cloudflare Browser Rendering (a BROWSER binding) or Battle.net keys on this server."] : []),
      ...(page.renderedText ? ["Gear wasn't in a format this server could parse; renderedText is the page as a player sees it. Read the gear from it and pass the stats to compare_items."] : []),
    ];
    if (!page.equipped.length) notes.push("The armory page doesn't include gear, so ask the player what they're wearing (or which items they're choosing between) and pass the stats to compare_items.");
    if (!page.class) notes.push("The armory page left the class blank; ask the player.");
    return reply({
      character: { name, surname, title: page.title, level: page.level ?? null, race: page.race ?? null, class: page.class ?? null, averageItemLevel: page.averageItemLevel ?? null },
      equipped: page.equipped.map(withUrl),
      gearSource: page.gearSource,
      ...(page.renderedText ? { renderedText: page.renderedText } : {}),
      ...((debug || !page.equipped.length) && page.debug ? { pageDebug: capJson(page.debug, 12_000) } : {}),
      confidence: single({ tier: "official", note: "parsed from Blizzard's public armory page; updates when the character logs out" }),
      sources: [{ id: "blizzard_armory", name: "World of Warcraft Forever armory", url: page.url, credit: BLIZZARD_CREDIT }],
      notes,
    });
  }));

  function characterFromApi({ profile, equipment, specs }: Awaited<ReturnType<Blizzard["character"]>>) {
    const pick = (o: unknown, ...path: string[]) => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
    const gear = ((pick(equipment, "equipped_items") as Record<string, unknown>[] | undefined) ?? []).map((it) => {
      const n = normaliseStats(pick(it, "stats") ?? []);
      const dps = pick(it, "weapon", "dps", "value");
      if (typeof dps === "number") n.stats.weapon_dps = dps;
      const armor = pick(it, "armor", "value");
      if (typeof armor === "number") n.stats.armor = armor;
      return { slot: pick(it, "slot", "type"), itemId: pick(it, "item", "id"), name: pick(it, "name"), quality: pick(it, "quality", "type"), level: pick(it, "level", "value"), stats: n.stats, enchants: pick(it, "enchantments") };
    });
    const totals: Stats = {};
    for (const g of gear) for (const [k, v] of Object.entries(g.stats)) totals[k as keyof Stats] = (totals[k as keyof Stats] ?? 0) + (k === "weapon_dps" ? 0 : (v as number));
    return reply({
      character: {
        name: pick(profile, "name"), surname: pick(profile, "surname"), level: pick(profile, "level"),
        class: pick(profile, "character_class", "name"), race: pick(profile, "race", "name"), faction: pick(profile, "faction", "name"),
        ruleset: pick(profile, "ruleset", "name") ?? pick(profile, "ruleset"), guild: pick(profile, "guild", "name"),
        averageItemLevel: pick(profile, "average_item_level"), lastLogin: pick(profile, "last_login_timestamp"),
      },
      specializations: specs ?? "not available",
      equipped: gear.map(withUrl),
      gearStatTotals: totals,
      confidence: single({ tier: "official", note: "live from Blizzard; updates when the character logs out" }),
      sources: [blizzardSrc()],
    });
  }

  // ───────────────────────── Levelling ─────────────────────────

  server.registerTool("xp_calculator", {
    title: "XP calculator",
    description: "XP maths for WoW: Forever: XP needed between levels, XP per mob kill (level difference, elite, rested, group, food buffs), kills to level, rested pool from time resting, and quest XP penalties for low quests. Labels which numbers are Forever-sourced and which are Classic baselines.",
    inputSchema: {
      level: z.number().int().min(1).max(60),
      targetLevel: z.number().int().min(2).max(60).optional(),
      xpIntoLevel: z.number().int().min(0).default(0),
      mobLevel: z.number().int().min(1).max(63).optional(),
      elite: z.boolean().default(false),
      rested: z.boolean().default(false),
      groupLevels: z.array(z.number().int().min(1).max(60)).max(5).optional().describe("Levels of everyone in the group including you."),
      wellFed: z.boolean().default(false),
      sleepingBagStacks: z.number().int().min(0).max(3).default(0),
      hoursResting: z.number().min(0).optional().describe("Hours logged out or idle in an inn, capital or on a Cozy Sleeping Bag."),
      wellRestedRanks: z.number().int().min(0).max(5).default(0),
      questLevel: z.number().int().min(1).max(60).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const target = a.targetLevel ?? Math.min(60, a.level + 1);
    const needed = xp.xpBetween(a.level, target, a.xpIntoLevel);
    const out: Record<string, unknown> = {
      level: a.level, targetLevel: target, xpNeeded: needed, xpToNextLevel: xp.xpToNext(a.level),
      greyMobLevelAndBelow: xp.greyLevel(a.level),
    };
    const ev: Evidence[] = [{ tier: "community_guide", note: "XP per level table" }];
    if (a.mobLevel !== undefined) {
      const per = xp.mobXp(a.level, a.mobLevel, { elite: a.elite, rested: a.rested, groupLevels: a.groupLevels, wellFed: a.wellFed, sleepingBagStacks: a.sleepingBagStacks });
      out.xpPerKill = per;
      out.killsToTarget = per > 0 ? Math.ceil(needed / per) : null;
      if (per === 0) out.mobNote = "Grey mob: no XP.";
      ev.push({ tier: "classic_baseline", note: "mob kill XP formula" });
    }
    if (a.hoursResting !== undefined) {
      out.restedPool = xp.restedPool(a.level, a.hoursResting, a.wellRestedRanks);
      ev.push({ tier: "community_guide", note: "rested accrual rules" });
    }
    if (a.questLevel !== undefined) {
      out.questXpMultiplier = xp.questXpMultiplier(a.level, a.questLevel);
      ev.push({ tier: "community_guide", note: "low-level quest penalty" });
    }
    return reply({
      ...out,
      // The XP table alone: a Forever guide and the Classic table agree exactly.
      confidence: ev.length === 1 ? agree([{ tier: "community_guide", note: "Forever XP table" }, { tier: "classic_baseline", note: "identical to Classic 1.12" }]) : derived(ev),
      sources: [sourceRef("warcraft_tavern_xp"), ...(a.mobLevel !== undefined ? [sourceRef("classic_baseline")] : []), { id: "kb", name: "kb/formulas/xp.yaml", url: "kb/formulas/xp.yaml" }],
      notes: a.groupLevels && a.groupLevels.some((l) => l - a.level >= 5) ? ["Forever penalises kill XP more than Classic when a much higher-level player is in the group; the real number will be lower."] : undefined,
    });
  });

  server.registerTool("levelling_plan", {
    title: "Compare levelling activities",
    description: "Compare ways to level (questing routes, grinding spots, dungeons) by XP per hour and, optionally, gold per hour, and estimate time to a target level. Give each activity's XP gained and minutes taken from your own play or a guide. Includes rested XP if you have some.",
    inputSchema: {
      level: z.number().int().min(1).max(59),
      targetLevel: z.number().int().min(2).max(60),
      xpIntoLevel: z.number().int().min(0).default(0),
      restedXp: z.number().int().min(0).default(0).describe("Rested XP pool in XP points (bubbles x 5% of a level)."),
      activities: z.array(z.object({
        name: z.string(),
        xp: z.number().min(0).describe("XP gained in the session."),
        minutes: z.number().positive(),
        killXpShare: z.number().min(0).max(1).default(0.5).describe("Share of the XP from kills (rested only doubles kill XP). Grinding ~1, questing ~0.4."),
        goldCopper: z.number().min(0).optional().describe("Gold earned in the session, in copper (vendor + loot)."),
      })).min(1).max(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const needed = xp.xpBetween(a.level, a.targetLevel, a.xpIntoLevel);
    const rows = a.activities.map((act) => {
      const perHour = (act.xp / act.minutes) * 60;
      const killPerHour = perHour * act.killXpShare;
      // Rested doubles kill XP until the pool runs out, so the bonus can't exceed the kill XP still to earn:
      // bonus = min(pool, share * (needed - bonus))  =>  bonus = min(pool, share * needed / (1 + share)).
      const restedBonusTotal = Math.min(a.restedXp, (act.killXpShare * needed) / (1 + act.killXpShare));
      const hoursRested = killPerHour > 0 ? restedBonusTotal / killPerHour : 0;
      const xpLeftAfterBonus = Math.max(0, needed - restedBonusTotal);
      const hours = perHour > 0 ? xpLeftAfterBonus / perHour : Infinity;
      return {
        name: act.name,
        xpPerHour: Math.round(perHour),
        hoursToTarget: Number.isFinite(hours) ? Math.round(hours * 10) / 10 : null,
        restedHelpsForHours: Math.round(hoursRested * 10) / 10,
        goldPerHour: act.goldCopper !== undefined ? formatCopper((act.goldCopper / act.minutes) * 60) : undefined,
        goldPerHourCopper: act.goldCopper !== undefined ? Math.round((act.goldCopper / act.minutes) * 60) : undefined,
      };
    }).sort((x, y) => y.xpPerHour - x.xpPerHour);
    return reply({
      xpNeeded: needed,
      best: rows[0]?.name,
      activities: rows,
      confidence: derived([{ tier: "user_provided", note: "activity XP and times" }, { tier: "community_guide", note: "XP table" }]),
      sources: [sourceRef("warcraft_tavern_xp"), { id: "kb", name: "kb/formulas/README.md", url: "kb/formulas/README.md" }],
      notes: [
        "A session of 20+ minutes gives a much steadier XP/hour than a single quest.",
        "Rested XP doubles kill XP only, so it favours grinding and kill-heavy quests.",
        "For routes, the Polestar guide addon (https://github.com/fitzforge/polestar) is the community favourite.",
      ],
    });
  });

  // ───────────────────────── Gold and professions ─────────────────────────

  server.registerTool("market_price", {
    title: "Auction house prices",
    description: "Live WoW: Forever auction house prices: lowest buyout, market price (average of the cheapest 15% of units), units listed and what you'd net after the cut. Read hourly from Blizzard's API per auction house; give region and faction (Horde, Alliance, or neutral for Blackwater). Falls back to Everloot player scans when Blizzard isn't set up. Use auction_houses to see which house is which.",
    inputSchema: {
      itemIds: z.array(z.number().int().positive()).min(1).max(10),
      faction: z.enum(["horde", "alliance", "neutral"]).optional().describe("The character's faction; neutral = Blackwater auction house."),
      region: z.enum(["eu", "us", "kr", "tw"]).default("eu"),
      ruleset: z.string().optional().describe("Normal, PvP, Roleplay or Roleplay PvP. Picks the right house once its group is known; until then every group's house for the faction is shown."),
      houseId: z.number().int().positive().optional().describe("One auction house by id (from auction_houses), instead of faction."),
      realm: z.string().optional().describe("Old Everloot parameter (ruleset name), used only for the Everloot fallback."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ itemIds, faction, region, ruleset, houseId, realm }) => {
    const ah = deps.auctions;
    if (ah?.enabled && (faction || houseId)) {
      const houses = await pickHouses(ah, region, faction, ruleset, houseId);
      if (!houses.length) return reply({ error: "No auction house matches that.", houses: await ah.houses(region) });
      const snaps = await Promise.all(houses.map(async (h) => ({ h, snap: await ah.snapshot(region, h.id).catch((e: Error) => e) })));
      const names = deps.catalog ? await Promise.all(itemIds.map((id) => deps.catalog!.get(id).catch(() => undefined))) : [];
      const prices = itemIds.map((id, i) => ({
        itemId: id,
        name: names[i]?.n,
        url: `https://foreverdb.net/item/${id}`,
        byHouse: snaps.map(({ h, snap }) => {
          const label = houseLabel(region, h);
          if (snap instanceof Error) return { ...label, error: snap.message };
          const row = snap.items[String(id)];
          if (!row) return { ...label, listed: 0, price: "none listed", scannedAt: snap.scannedAt };
          const [min, market, units, listings] = row;
          return { ...label, lowest: formatCopper(min), market: formatCopper(market), marketCopper: market, netAfterCut: formatCopper(netAfterCut(market)), unitsListed: units, listings, scannedAt: snap.scannedAt };
        }),
      }));
      const oldest = Math.max(...snaps.map(({ snap }) => (snap instanceof Error ? 0 : (Date.now() - Date.parse(snap.scannedAt)) / 86_400_000)));
      return reply({
        region,
        prices,
        confidence: single({ tier: "official", ageDays: oldest, note: "live Blizzard auction data" }),
        sources: [{ ...sourceRef("blizzard"), credit: "Auction data from the Blizzard Battle.net API. World of Warcraft is a trademark of Blizzard Entertainment." }],
        notes: [
          `Net = market x ${1 - AH_CUT} (auction house cut, Classic baseline; Blackwater may take more).`,
          "These are asking prices of current listings, not sale prices. 'none listed' means nobody is selling it right now.",
          ...(houses.length > 1 ? ["Blizzard's API doesn't say which ruleset each group of houses serves yet, so every group is shown. The player's house is usually the one whose prices match what they see in game; auction_houses lists them."] : []),
        ],
      });
    }
    const rows = await Promise.all(itemIds.map((id) => priceOf(deps, realm ?? ruleset ?? "Normal", id)));
    return reply({
      realm: realm ?? ruleset ?? "Normal",
      prices: rows.map((r) => ({ ...r, evidence: undefined })),
      confidence: rows.some((r) => r.evidence) ? agree(rows.flatMap((r) => (r.evidence ? [r.evidence] : []))) : single({ tier: "classic_baseline", note: "no prices recorded" }),
      sources: [everlootSrc()],
      notes: [
        ah?.enabled ? "Give the faction (or a houseId) to get live Blizzard auction prices instead." : "Live Blizzard prices need BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET on the server.",
        "'unknown' means no solid scan in the last 14 days, not that the item is worthless.", `Net = market x ${1 - AH_CUT} (auction house cut).`,
      ],
    });
  }));

  server.registerTool("auction_houses", {
    title: "Auction houses",
    description: "The WoW: Forever auction houses in Blizzard's API for a region: id, faction, group (ruleset when known), when prices were last read and how many listings. Give itemId to compare one item's price across every house, which helps tell which house is the player's (e.g. Linen Cloth 2589).",
    inputSchema: {
      region: z.enum(["eu", "us", "kr", "tw"]).default("eu"),
      itemId: z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ region, itemId }) => {
    const ah = deps.auctions;
    if (!ah?.enabled) return reply({ error: "Blizzard API is not set up on this server, so there's no auction data." });
    const houses = await ah.houses(region);
    const rows = await Promise.all(houses.map(async (h) => {
      const label = houseLabel(region, h);
      const snap = await ah.snapshot(region, h.id).catch((e: Error) => e);
      if (snap instanceof Error) return { ...label, error: snap.message };
      const row = itemId ? snap.items[String(itemId)] : undefined;
      return {
        ...label, scannedAt: snap.scannedAt, listings: snap.listings, distinctItems: Object.keys(snap.items).length,
        ...(itemId ? { item: row ? { lowest: formatCopper(row[0]), market: formatCopper(row[1]), unitsListed: row[2] } : "none listed" } : {}),
      };
    }));
    return reply({
      region, houses: rows,
      sources: [{ ...sourceRef("blizzard"), credit: "Auction data from the Blizzard Battle.net API. World of Warcraft is a trademark of Blizzard Entertainment." }],
      notes: ["A group is one ruleset's Alliance, Horde and Blackwater houses (the nth house of each faction). Group 3 (112, 115, 118) is empty. In the EU, group 1 is PvP and group 2 is Normal (matched against in-game prices); groups 4 and 5 are thought to be the two Roleplay rulesets (Forever Mastery)."],
    });
  }));

  server.registerTool("gold_opportunities", {
    title: "Gold opportunities on the auction house",
    description: "The latest auction house money makers the server found for its watched house: items listed well under their usual price, the 7-day median (buy and relist), prices spiking (sell now), and cheap greens worth more disenchanted. A few times a day the server saves prices to its database, picks candidates with simple maths, adds how well each item actually sells (estimated from auctions vanishing between hourly reads) and has Claude Haiku rank them, within a daily spending cap. Give sinceIso to get only the finds flagged noteworthy after that time.",
    inputSchema: {
      houseId: z.number().int().positive().optional().describe("Defaults to the first watched house."),
      sinceIso: z.string().optional().describe("ISO time: return only noteworthy finds saved after it."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ houseId, sinceIso }) => {
    const gold = deps.gold;
    if (!gold) return reply({ error: "The gold finder isn't switched on here. It needs a D1 database bound as DB and GOLD_HOUSE_IDS set (ANTHROPIC_API_KEY adds the AI review)." });
    const id = houseId ?? gold.houseIds[0];
    const spend = await gold.spentToday();
    const credit = [{ ...sourceRef("blizzard"), credit: "Auction data from the Blizzard Battle.net API. World of Warcraft is a trademark of Blizzard Entertainment." }];
    const budget = { spentTodayUsd: Math.round(spend.usd * 1e4) / 1e4, reviewsToday: spend.calls, dailyCapUsd: gold.settingsView.dailyBudgetUsd };
    const link = <T extends { itemId: number }>(o: T) => ({ ...o, url: `https://foreverdb.net/item/${o.itemId}` });
    if (sinceIso) {
      const since = Date.parse(sinceIso);
      if (!Number.isFinite(since)) return fail("sinceIso isn't a valid time.");
      const finds = await gold.noteworthySince(id, since);
      return reply({ houseId: id, since: sinceIso, noteworthy: finds.map((o) => ({ ...link(o), buyAtMost: formatCopper(o.buyAtMostCopper), sellAt: formatCopper(o.sellAtCopper), expectedProfit: formatCopper(o.expectedProfitCopper) })), budget, sources: credit });
    }
    const a = await gold.latest(id);
    if (!a) return reply({ houseId: id, note: "No list yet. The first one appears within a few hours of the database being set up.", settings: gold.settingsView, budget });
    return reply({
      houseId: id, foundAt: a.at, reviewedBy: a.model, ...(a.skipped ? { aiSkipped: a.skipped } : {}), summary: a.summary, candidatesChecked: a.candidates,
      opportunities: a.opportunities.map((o) => ({ ...link(o), buyAtMost: formatCopper(o.buyAtMostCopper), sellAt: formatCopper(o.sellAtCopper), expectedProfit: formatCopper(o.expectedProfitCopper) })),
      budget,
      confidence: single({ tier: "official", ageDays: (Date.now() - Date.parse(a.at)) / 86_400_000, note: "listing prices from Blizzard; disenchant values use the Classic 1.12 table" }),
      sources: credit,
      notes: ["Asking prices, not sale prices: check the listing in game before you buy.", "Disenchant odds are the Classic 1.12 baseline; Forever may differ.", "Profits are after the 5% auction house cut."],
    });
  }));

  server.registerTool("price_history", {
    title: "Price history and sell-through",
    description: "Hourly auction prices for trade goods (cloth, leather, herbs, ore, enchanting mats, elementals...) on the server's watched house, kept 60 days, plus how well items sell. With itemId: every saved hour, the typical price by hour of day and weekday (UTC), the lowest listing now against the 7-day median, and sales per day. Without itemId: one row per trade good with its cheapest and dearest hour, swing, how far under its usual price it is now, and sales per day; filter with category. Sales are estimated for every item, not just trade goods, from auctions that vanish between reads while they still had hours left (cancellations count too).",
    inputSchema: {
      itemId: z.number().int().positive().optional(),
      category: z.string().optional().describe("Trade goods kind, e.g. Herb, Cloth, Leather, Metal & Stone, Enchanting, Elemental, Meat."),
      days: z.number().int().min(1).max(60).default(14),
      houseId: z.number().int().positive().optional().describe("Defaults to the first watched house."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, safe(async ({ itemId, category, days, houseId }) => {
    const h = deps.history;
    if (!h) return reply({ error: "Price history isn't switched on here. It needs a D1 database bound as DB and GOLD_HOUSE_IDS set." });
    const id = houseId ?? h.watched[0];
    if (!h.watches(id)) return fail(`House ${id} isn't watched. Watched: ${h.watched.join(", ")}.`);
    const now = Date.now();
    const credit = [{ ...sourceRef("blizzard"), credit: BLIZZARD_CREDIT }];
    const notes = [
      "Prices in copper, asking prices of listings, not sale prices. Hours and weekdays are UTC.",
      "Market = average of the cheapest 15% of units. Typical = median market price over the period.",
      "Sales: an auction that vanished between two reads with 2+ hours left counts as bought (a cancellation looks the same, so treat it as an upper bound). sellRatePct = bought / (bought + ended near expiry). Unknown until the server has tracked a day.",
    ];
    const coverage = await h.coverage(id);
    if (itemId) {
      const [points, sales, info] = await Promise.all([h.points(id, itemId, days, now), h.sales(id, Math.min(days, 60), [itemId], now), deps.catalog?.get(itemId).catch(() => undefined)]);
      const last = points[points.length - 1];
      return reply({
        houseId: id, itemId, item: info?.n, url: itemUrl(itemId), category: await h.tradeGood(itemId), days, coverage,
        profile: profile(points),
        now: last ? { at: new Date(last.at).toISOString(), lowest: last.lowest, market: last.market, units: last.units, ...belowUsual(points, last.lowest, now) } : undefined,
        sales: sellThrough(sales.byItem.get(itemId), sales.days),
        points: points.map((p) => ({ at: new Date(p.at).toISOString(), lowest: p.lowest, market: p.market, units: p.units, listings: p.listings })),
        ...(points.length ? {} : { note: "No hourly prices for this item. Only trade goods are saved hourly; sales are still tracked for every item." }),
        confidence: single({ tier: "official", ageDays: last ? (now - last.at) / 86_400_000 : undefined, note: "Blizzard listings; sales are an estimate" }),
        sources: credit, notes,
      });
    }
    const [all, sales] = await Promise.all([h.allPoints(id, days, now), h.sales(id, Math.min(days, 60), undefined, now)]);
    const want = category?.toLowerCase().trim();
    const items = [];
    for (const [iid, pts] of all) {
      const cat = await h.tradeGood(iid);
      if (want && !(cat ?? "").toLowerCase().includes(want)) continue;
      const pr = profile(pts), last = pts[pts.length - 1], st = sellThrough(sales.byItem.get(iid), sales.days);
      const hourPrice = (hr?: number) => pr.byHourUtc.find((x) => x.hour === hr)?.market;
      items.push({
        itemId: iid, item: (await deps.catalog?.get(iid).catch(() => undefined))?.n ?? `Item ${iid}`, category: cat ?? "Trade Goods",
        typical: pr.typical, cheapestHourUtc: pr.cheapestHourUtc, cheapPrice: hourPrice(pr.cheapestHourUtc), dearestHourUtc: pr.dearestHourUtc, dearPrice: hourPrice(pr.dearestHourUtc), swingPct: pr.swingPct,
        lowestNow: last?.lowest, unitsNow: last?.units, pctOfUsual: belowUsual(pts, last?.lowest ?? 0, now).pctOfUsual,
        soldUnitsPerDay: st.soldUnitsPerDay, sellRatePct: st.sellRatePct, samples: pr.samples, daysOfData: pr.days,
      });
    }
    items.sort((a, b) => (b.swingPct ?? -1) - (a.swingPct ?? -1));
    return reply({
      houseId: id, days, category, coverage, salesDays: sales.days,
      belowUsualNow: items.filter((x) => x.pctOfUsual !== undefined && x.pctOfUsual <= 70).map((x) => ({ itemId: x.itemId, item: x.item, lowestNow: x.lowestNow, pctOfUsual: x.pctOfUsual })),
      items,
      sources: credit, notes,
    });
  }));

  server.registerTool("farm_value", {
    title: "Gold per hour from farming",
    description: "Estimate gold per hour from a farm: give items gathered or looted per hour and the realm; prices come from Everloot auction data (or your own price), minus the auction house cut, plus any vendor trash value.",
    inputSchema: {
      realm: z.string().describe("Ruleset, e.g. 'Normal'."),
      faction: z.enum(["horde", "alliance", "neutral"]).optional().describe("With region, uses live Blizzard auction prices."),
      region: z.enum(["eu", "us", "kr", "tw"]).default("eu"),
      houseId: z.number().int().positive().optional(),
      perHour: z.array(z.object({
        itemId: z.number().int().positive().optional(),
        name: z.string().optional(),
        count: z.number().min(0),
        priceCopper: z.number().min(0).optional().describe("Your own price per item; skips the lookup."),
      })).min(1).max(15),
      vendorCopperPerHour: z.number().min(0).default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ realm, faction, region, houseId, perHour, vendorCopperPerHour }) => {
    const ev: Evidence[] = [];
    const ah = deps.auctions;
    // One house is needed for a single figure: the one asked for, or the faction's house for this ruleset when known.
    const house = ah?.enabled && (houseId || faction) ? (await pickHouses(ah, region, faction, realm, houseId).catch(() => []))[0] : undefined;
    const single1 = house && (houseId || GROUP_RULESETS[region]) ? house : undefined;
    const usedBlizzard = { yes: false };
    const lines = [];
    let total = vendorCopperPerHour;
    let unknown = 0;
    for (const p of perHour) {
      let unit: number | null = p.priceCopper ?? null;
      let note: string | undefined;
      if (unit === null && p.itemId) {
        const pr = single1 ? await blizzardPrice(ah!, region, single1.id, p.itemId) : await priceOf(deps, realm, p.itemId);
        if (single1) usedBlizzard.yes = true;
        unit = pr.marketCopper ?? null;
        if (pr.evidence) ev.push(pr.evidence);
        note = pr.note;
      } else if (unit !== null) ev.push({ tier: "user_provided" });
      const net = unit !== null ? netAfterCut(unit) * p.count : null;
      if (net === null) unknown++;
      else total += net;
      lines.push({ item: p.name ?? p.itemId, count: p.count, unitPrice: formatCopper(unit), netPerHour: formatCopper(net), note });
    }
    return reply({
      realm,
      goldPerHour: formatCopper(total),
      goldPerHourCopper: Math.round(total),
      itemsWithoutPrice: unknown,
      lines,
      ...(single1 ? { auctionHouse: houseLabel(region, single1) } : {}),
      confidence: ev.length ? derived(ev, "farm value formula") : single({ tier: "classic_baseline", note: "no prices" }),
      sources: [usedBlizzard.yes ? { ...sourceRef("blizzard"), credit: "Auction data from the Blizzard Battle.net API." } : everlootSrc()],
      notes: [
        ...(unknown ? [`${unknown} item(s) had no price and were left out, so the real figure is higher.`] : []),
        ...(!single1 && faction && ah?.enabled ? ["Which auction house is this ruleset's isn't known yet: pass houseId (see auction_houses) for live prices."] : []),
      ],
    });
  }));

  server.registerTool("profession_cost", {
    title: "Profession levelling cost",
    description: "The cheapest known path to level a WoW: Forever profession between two skill levels, with the recipes, reagents and total cost. Built from Everloot player data; gaps where no agreed recipe exists are shown, never invented.",
    inputSchema: {
      profession: z.string().describe("e.g. 'blacksmithing', 'tailoring', 'alchemy'."),
      fromSkill: z.number().int().min(1).max(300).default(1),
      toSkill: z.number().int().min(2).max(300),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ profession, fromSkill, toSkill }) => {
    const ev = await everloot.call("profession_path", { profession: profession.toLowerCase(), fromSkill, toSkill });
    const page = (ev.structured?.page ?? {}) as { steps?: { copper?: number | null; reporters?: number }[]; copper?: number | null; gaps?: unknown[]; reagents?: unknown[] };
    const steps = page.steps ?? [];
    const known = steps.filter((s) => typeof s.copper === "number").reduce((a, s) => a + (s.copper as number), 0);
    const missing = steps.filter((s) => s.copper === null || s.copper === undefined).length;
    const minReporters = steps.reduce((m, s) => Math.min(m, s.reporters ?? 3), Infinity);
    let foreverdbRecipes: unknown;
    if (foreverdb.enabled) foreverdbRecipes = await foreverdb.get(`professions/${profession.toLowerCase()}`, { limit: 100 }).then((r) => r.data).catch(() => undefined);
    return reply({
      profession, fromSkill, toSkill,
      ...(ev.structured ? { path: page } : { text: ev.text }),
      totalCost: page.copper !== null && page.copper !== undefined ? formatCopper(page.copper) : `at least ${formatCopper(known)} (${missing} step(s) without a price)`,
      gaps: page.gaps ?? [],
      ...(foreverdbRecipes !== undefined ? { foreverdbRecipes } : {}),
      confidence: steps.length ? single({ tier: "player_observed", reporters: Number.isFinite(minReporters) ? minReporters : 3, thin: missing > 0 }) : single({ tier: "classic_baseline", note: "no agreed path yet" }),
      sources: [everlootSrc(ev.structured?.url as string | undefined), ...(foreverdbRecipes ? [foreverdbSrc()] : [])],
      notes: ["Costs are reagent prices at time of the scan. Gathering mats yourself makes it cheaper; use farm_value to see what that time is worth.", "For the step-by-step route (what to craft at each skill), use profession_guide, which works even when this path has gaps."],
    });
  }));

  server.registerTool("confidence_score", {
    title: "Score confidence",
    description: "Score how sure we can be about a claim from its evidence, using the shared scoring rules (kb/formulas/README.md). Use mode 'agree' when sources independently say the same thing, 'derived' when the claim is computed from inputs.",
    inputSchema: {
      mode: z.enum(["agree", "derived"]).default("agree"),
      evidence: z.array(z.object({
        tier: z.enum(["official", "player_observed", "game_files", "user_provided", "community_guide", "classic_baseline"]),
        reporters: z.number().int().min(0).optional(),
        ageDays: z.number().min(0).optional(),
        thin: z.boolean().optional(),
        note: z.string().optional(),
      })).min(1).max(20),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ mode, evidence }) => reply({ confidence: mode === "agree" ? agree(evidence) : derived(evidence) }));

  // ───────────────────────── Raw access ─────────────────────────

  server.registerTool("everloot", {
    title: "Everloot (any tool)",
    description: "Call any Everloot tool directly when the tools above don't cover it: npc_page, quest_page, vendor_page, object_page, entity_relations, world_map_near, recipe_thresholds, auction_history, population, answer_sources, get_by_name, talent_plan, item_categories and more. Call with tool 'list' to see them all. Answers are cached; the server shares 200 Everloot calls an hour.",
    inputSchema: {
      tool: z.string().describe("Everloot tool name, or 'list'."),
      args: z.record(z.string(), z.unknown()).default({}),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ tool, args }) => {
    if (tool === "list") return reply({ tools: await everloot.listTools(), sources: [everlootSrc()] });
    if (!/^[a-z_]{2,40}$/.test(tool)) return fail("Not a valid tool name.");
    const ev = await everloot.call(tool, args);
    return reply({ tool, result: ev.structured ?? ev.text, cached: ev.cached ?? false, sources: [everlootSrc(ev.structured?.url as string | undefined)] });
  }));

  server.registerTool("foreverdb", {
    title: "ForeverDB (any endpoint)",
    description: `Read any ForeverDB endpoint when the tools above don't cover it (needs a ForeverDB key on the server). Paths: ${FOREVERDB_PATHS.join(", ")}. Common params: q, limit, offset, class, zone, minLevel, maxLevel.`,
    inputSchema: {
      path: z.string().describe("e.g. 'items/19019', 'quests', 'classes/mage', 'buffs-nerfs'."),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ path, params }) => {
    const r = await foreverdb.get(path, params);
    return reply({ path, ...r, sources: [foreverdbSrc()] });
  }));

  // ───────────────────────── Prompt ─────────────────────────

  server.registerPrompt("optimize_build", {
    title: "Review my build",
    description: "A full levelling build review: talents, gear upgrades, levelling plan and professions, with sources and confidence.",
    argsSchema: {
      class: z.string().describe("Class, e.g. warrior"),
      spec: z.string().optional().describe("Spec, e.g. fury"),
      level: z.string().describe("Current level"),
      character: z.string().optional().describe("First and last name, if you want me to read your gear"),
      goal: z.string().optional().describe("What you care about: speed, gold, dungeons, PvP, solo"),
    },
  }, (a) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Review my WoW: Forever build. I'm a level ${a.level} ${a.spec ?? ""} ${a.class}.${a.character ? ` My character is ${a.character}.` : ""}${a.goal ? ` My goal: ${a.goal}.` : ""}

Please:
1. ${a.character ? "Read my character with character_lookup." : "Ask what gear I'm wearing if it matters."}
2. Check patch_changes for my class.
3. Use talent_tree and talent_points_by_level to suggest where my next points go and the plan to 60.
4. Use compare_items to find my weakest slots and what to look for (search_game for named upgrades in my level range).
5. Use xp_calculator / levelling_plan for my next 5 levels.
6. Suggest professions that help my class while levelling, with profession_cost.
Follow kb_guide 'rules': cite sources, give confidence labels, and flag Classic-baseline numbers.`,
      },
    }],
  }));

  return server;
}

// ───────────────────────── Shared helpers ─────────────────────────

async function fetchItem(deps: Deps, itemId: number): Promise<Record<string, unknown>> {
  const srcs: Src[] = [];
  const evidence: Evidence[] = [];
  const notes: string[] = [];
  let stats: Stats = {};
  let statsFrom: "foreverdb" | "everloot" | "both" | "none" = "none";
  let name: string | undefined;
  let foreverdbItem: unknown;

  const [fdb, ev, cat] = await Promise.all([
    deps.foreverdb.enabled ? deps.foreverdb.get(`items/${itemId}`).catch((e: Error) => ({ error: e.message })) : Promise.resolve(undefined),
    deps.everloot.call("item_page", { itemId }).catch((e: Error) => ({ error: e.message })),
    deps.everloot.call("item_categories", { item: itemId }).catch(() => undefined),
  ]);
  // Type, slot and quality from the game files: known for every item, even ones no player has reported.
  const catItem = cat?.structured?.item as Record<string, { name?: string } | null | number> | undefined;
  const category = catItem ? {
    type: (catItem.class as { name?: string } | null)?.name,
    subtype: (catItem.subclass as { name?: string } | null)?.name,
    slot: (catItem.slot as { name?: string } | null)?.name,
    quality: (catItem.quality as { name?: string } | null)?.name,
    from: `game files, build ${String(cat?.structured?.build ?? "unknown")} (unconfirmed)`,
  } : undefined;

  if (fdb && !("error" in fdb)) {
    const d = (fdb.data ?? {}) as Record<string, unknown>;
    foreverdbItem = d;
    name = (d.name as string) ?? name;
    const n = normaliseStats(d.stats ?? d.bonuses ?? {});
    stats = { ...n.stats };
    const dps = d.dps ?? (d.damage as Record<string, unknown> | undefined)?.dps;
    if (typeof dps === "number") stats.weapon_dps = dps;
    if (typeof d.armor === "number") stats.armor = d.armor;
    if (Object.keys(stats).length) statsFrom = "foreverdb";
    evidence.push({ tier: "game_files", note: `ForeverDB build ${String(fdb.meta?.build ?? d.dataFromBuild ?? "unknown")}` });
    srcs.push(foreverdbSrc());
  } else if (fdb && "error" in fdb) notes.push(fdb.error);

  // No API key: ForeverDB's item list (all stats, no page fetch), else its public item page.
  let siteItem: Awaited<ReturnType<ForeverDbSite["item"]>> | undefined;
  const row = !fdb && deps.catalog ? await deps.catalog.get(itemId).catch(() => undefined) : undefined;
  let catalogItem: ReturnType<typeof rowToItem> | undefined;
  if (row) {
    catalogItem = rowToItem(row);
    name = catalogItem.name;
    stats = { ...catalogItem.stats };
    if (Object.keys(stats).length) statsFrom = "foreverdb";
    evidence.push({ tier: "game_files", note: "ForeverDB item list (Forever client data)" });
    srcs.push({ ...foreverdbSrc(), url: catalogItem.url });
  } else if (!fdb && deps.foreverdbSite) {
    siteItem = await deps.foreverdbSite.item(itemId).catch((e: Error) => { notes.push(e.message); return undefined; });
    if (siteItem) {
      name = siteItem.name ?? name;
      stats = { ...siteItem.stats };
      if (Object.keys(stats).length) statsFrom = "foreverdb";
      evidence.push({ tier: "game_files", note: `ForeverDB item page${siteItem.build ? `, build ${siteItem.build}` : ""}` });
      srcs.push({ ...foreverdbSrc(), url: siteItem.url });
      if (siteItem.otherLines.length) notes.push(`Not scored: ${siteItem.otherLines.join("; ")}.`);
    }
  }

  let drops: unknown;
  let url: string | undefined;
  if (ev && !("error" in ev)) {
    const s = ev.structured ?? {};
    url = s.url as string | undefined;
    const page = (s.page ?? {}) as { name?: string | null; drops?: unknown[]; reported?: { shown?: { fact: string; value: number; reporters: number }[]; contested?: string[] } };
    name = name ?? page.name ?? undefined;
    drops = page.drops;
    const shown = page.reported?.shown ?? [];
    if (shown.length) {
      const observed = normaliseStats(shown.map((r) => ({ type: r.fact, value: r.value }))).stats;
      // Player reports confirm or fill in the game-file stats.
      for (const [k, v] of Object.entries(observed)) {
        const key = k as keyof Stats;
        if (stats[key] !== undefined && stats[key] !== v) notes.push(`${k}: game files say ${stats[key]}, players report ${v}. Using the player value.`);
        stats[key] = v;
      }
      statsFrom = statsFrom === "foreverdb" ? "both" : "everloot";
      const minRep = Math.min(...shown.map((r) => r.reporters));
      evidence.push({ tier: "player_observed", reporters: minRep, ageDays: ageDays(s.dataAsOf) });
    }
    if (page.reported?.contested?.length) notes.push(`Players disagree on: ${page.reported.contested.join(", ")}.`);
    if (s.connected === false) notes.push(`Everloot: ${String(s.reason ?? "no data read")}`);
    srcs.push(everlootSrc(url));
  } else if (ev && "error" in ev) notes.push(ev.error);

  if (statsFrom === "none") notes.push("No stats found from any source yet.");
  if (!name && category) notes.push("The item exists in the game files, but no player has reported its name yet.");
  return {
    itemId, name: name ?? null, url: itemUrl(itemId), ...(category ? { category } : {}),
    ...(catalogItem ? { quality: catalogItem.quality, itemLevel: catalogItem.itemLevel, requiredLevel: catalogItem.requiredLevel, type: catalogItem.type, slot: catalogItem.slot, damage: catalogItem.damage, statLines: catalogItem.statLines, newInForever: catalogItem.newInForever, changedFromClassic: catalogItem.changedFromClassic } : {}),
    ...(siteItem ? { quality: siteItem.quality, itemLevel: siteItem.itemLevel, requiredLevel: siteItem.requiredLevel, slot: siteItem.slot, armorType: siteItem.armorType, damage: siteItem.damage, source: siteItem.source } : {}),
    stats, statsFrom,
    ...(drops ? { drops } : {}),
    ...(foreverdbItem ? { foreverdbItem } : {}),
    confidence: evidence.length ? agree(evidence) : { label: "low", score: 0, reasons: ["no source has this item"] },
    sources: srcs, notes,
  };
}

function houseLabel(region: string, h: HouseInfo) {
  const ruleset = GROUP_RULESETS[region as keyof typeof GROUP_RULESETS]?.[h.group];
  return { houseId: h.id, house: h.name, faction: h.faction ?? "unknown", group: h.group, ...(ruleset ? { ruleset } : {}) };
}

/** The houses to read: one by id, the faction's house for a known ruleset, or the faction's house in every group. */
async function pickHouses(ah: AuctionPrices, region: "eu" | "us" | "kr" | "tw", faction?: Faction, ruleset?: string, houseId?: number): Promise<HouseInfo[]> {
  const all = await ah.houses(region);
  if (houseId) return all.filter((h) => h.id === houseId);
  const mine = all.filter((h) => h.faction === faction);
  const groups = GROUP_RULESETS[region];
  if (groups && ruleset) {
    const want = ruleset.toLowerCase().replace(/[^a-z]/g, "");
    const hit = mine.filter((h) => groups[h.group]?.toLowerCase().replace(/[^a-z]/g, "") === want);
    if (hit.length) return hit;
  }
  return mine;
}

async function blizzardPrice(ah: AuctionPrices, region: "eu" | "us" | "kr" | "tw", houseId: number, itemId: number) {
  const snap = await ah.snapshot(region, houseId);
  const row = snap.items[String(itemId)];
  const ageDays = (Date.now() - Date.parse(snap.scannedAt)) / 86_400_000;
  if (!row) return { itemId, market: "unknown", marketCopper: null as number | null, note: "none listed right now", evidence: undefined as Evidence | undefined };
  return { itemId, market: formatCopper(row[1]), marketCopper: row[1] as number | null, note: undefined as string | undefined, evidence: { tier: "official", ageDays } as Evidence };
}

async function priceOf(deps: Deps, realm: string, itemId: number) {
  const ev = await deps.everloot.call("market_value", { realm, itemId }).catch((e: Error) => ({ error: e.message } as const));
  if ("error" in ev) return { itemId, market: "unknown", marketCopper: null as number | null, note: ev.error, evidence: undefined as Evidence | undefined };
  const v = ((ev.structured?.page as Record<string, unknown> | undefined)?.value ?? null) as { market: number | null; min: number; quantity: number; ageDays: number; reporters: number; thin: boolean; historical: number } | null;
  if (!v || v.market === null) return { itemId, market: "unknown", marketCopper: null, note: ev.structured ? "no recent scans" : ev.text.slice(0, 300), evidence: undefined };
  return {
    itemId,
    market: formatCopper(v.market), marketCopper: v.market,
    minBuyout: formatCopper(v.min), historical: formatCopper(v.historical), listed: v.quantity,
    netAfterCut: formatCopper(netAfterCut(v.market)),
    scanAgeDays: v.ageDays, thin: v.thin,
    note: undefined as string | undefined,
    evidence: { tier: "player_observed", reporters: v.reporters, ageDays: v.ageDays, thin: v.thin } as Evidence,
  };
}

export { STAT_KEYS };
