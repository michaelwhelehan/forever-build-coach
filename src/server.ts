import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { kbText, kbFiles, sources, sourceRef } from "./kb.js";
import { Everloot, EVERLOOT_CREDIT } from "./sources/everloot.js";
import { ForeverDb, FOREVERDB_CREDIT, FOREVERDB_PATHS } from "./sources/foreverdb.js";
import type { ForeverDbSite } from "./sources/foreverdb-site.js";
import { Blizzard, BLIZZARD_CREDIT } from "./sources/blizzard.js";
import { fetchArmory, armoryUrl } from "./sources/armory.js";
import type { BrowserWorker } from "@cloudflare/puppeteer";
import { agree, derived, single, type Confidence, type Evidence } from "./formulas/confidence.js";
import { normaliseStats, scoreStats, weightsFor, specsFor, STAT_KEYS, type Stats } from "./formulas/stats.js";
import * as xp from "./formulas/xp.js";
import { netAfterCut, formatCopper, AH_CUT } from "./formulas/gold.js";

export const VERSION = "0.3.0";

const CLASSES = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"] as const;
const classEnum = z.enum(CLASSES);

export const INSTRUCTIONS = `Forever Build Coach helps players optimise World of Warcraft: Forever characters while levelling: gear choices, talents, levelling speed, professions and gold.

Rules for every answer (full text: kb_guide topic "rules"):
1. Cite the source of each game fact. Tool results carry a "sources" list; pass it on.
2. Repeat the confidence label (high / medium / low) for anything a recommendation depends on.
3. WoW: Forever is not Classic 1.12. Classic numbers are a baseline only and must be flagged.
4. Missing data is unknown, never zero.
5. Show the inputs when a recommendation rests on a formula (stat score, XP/hour, gold/hour).

Good starting points: character_lookup (if the player gives name + surname), talent_tree, compare_items, levelling_plan, profession_cost. Use the optimize_build prompt for a full review.`;

export interface Deps { everloot: Everloot; foreverdb: ForeverDb; foreverdbSite?: ForeverDbSite; blizzard: Blizzard; browser?: BrowserWorker }

type Src = { id: string; name: string; url: string; credit?: string };

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
      } else if (deps.foreverdbSite) {
        foreverdbItems = await deps.foreverdbSite.search(query, limit).catch((e: Error) => ({ error: e.message }));
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
      results.push({ itemId: it.itemId, name: name ?? `item ${results.length + 1}`, score: scored.score, breakdown: scored.breakdown, statsNotWeighted: scored.ignored, itemConfidence, notes });
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
      equipped: page.equipped,
      gearSource: page.gearSource,
      ...(page.renderedText ? { renderedText: page.renderedText } : {}),
      // Always included for now: the armory page's layout is new and still being mapped (fewer slots than the page shows).
      ...(page.debug ? { pageDebug: capJson(page.debug, debug || !page.equipped.length ? 12_000 : 6_000) } : {}),
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
      equipped: gear,
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
    description: "Current market value, minimum buyout and listings for items on a WoW: Forever realm/ruleset, from auction scans players uploaded to Everloot, with what you'd net after the auction house cut.",
    inputSchema: {
      realm: z.string().describe("Realm or ruleset name as Everloot knows it, e.g. 'PvP' or 'Normal' (Forever has one mega-realm per ruleset)."),
      itemIds: z.array(z.number().int().positive()).min(1).max(10),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ realm, itemIds }) => {
    const rows = await Promise.all(itemIds.map((id) => priceOf(deps, realm, id)));
    return reply({
      realm,
      prices: rows.map((r) => ({ ...r, evidence: undefined })),
      confidence: rows.some((r) => r.evidence) ? agree(rows.flatMap((r) => (r.evidence ? [r.evidence] : []))) : single({ tier: "classic_baseline", note: "no prices recorded" }),
      sources: [everlootSrc()],
      notes: ["'unknown' means no solid scan in the last 14 days, not that the item is worthless.", `Net = market x ${1 - AH_CUT} (auction house cut).`],
    });
  }));

  server.registerTool("farm_value", {
    title: "Gold per hour from farming",
    description: "Estimate gold per hour from a farm: give items gathered or looted per hour and the realm; prices come from Everloot auction data (or your own price), minus the auction house cut, plus any vendor trash value.",
    inputSchema: {
      realm: z.string(),
      perHour: z.array(z.object({
        itemId: z.number().int().positive().optional(),
        name: z.string().optional(),
        count: z.number().min(0),
        priceCopper: z.number().min(0).optional().describe("Your own price per item; skips the lookup."),
      })).min(1).max(15),
      vendorCopperPerHour: z.number().min(0).default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, safe(async ({ realm, perHour, vendorCopperPerHour }) => {
    const ev: Evidence[] = [];
    const lines = [];
    let total = vendorCopperPerHour;
    let unknown = 0;
    for (const p of perHour) {
      let unit: number | null = p.priceCopper ?? null;
      let note: string | undefined;
      if (unit === null && p.itemId) {
        const pr = await priceOf(deps, realm, p.itemId);
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
      confidence: ev.length ? derived(ev, "farm value formula") : single({ tier: "classic_baseline", note: "no prices" }),
      sources: [everlootSrc()],
      notes: unknown ? [`${unknown} item(s) had no price and were left out, so the real figure is higher.`] : undefined,
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
      notes: ["Costs are reagent prices at time of the scan. Gathering mats yourself makes it cheaper; use farm_value to see what that time is worth."],
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

  // No API key: read ForeverDB's public item page instead (stats from the Forever client).
  let siteItem: Awaited<ReturnType<ForeverDbSite["item"]>> | undefined;
  if (!fdb && deps.foreverdbSite) {
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
    itemId, name: name ?? null, ...(category ? { category } : {}),
    ...(siteItem ? { quality: siteItem.quality, itemLevel: siteItem.itemLevel, requiredLevel: siteItem.requiredLevel, slot: siteItem.slot, armorType: siteItem.armorType, damage: siteItem.damage, source: siteItem.source } : {}),
    stats, statsFrom,
    ...(drops ? { drops } : {}),
    ...(foreverdbItem ? { foreverdbItem } : {}),
    confidence: evidence.length ? agree(evidence) : { label: "low", score: 0, reasons: ["no source has this item"] },
    sources: srcs, notes,
  };
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
