import { describe, it, expect } from "vitest";
import * as xp from "../src/formulas/xp.js";
import { normaliseStats, scoreStats, weightsFor } from "../src/formulas/stats.js";
import { agree, derived, single } from "../src/formulas/confidence.js";
import { formatCopper, netAfterCut } from "../src/formulas/gold.js";

describe("xp", () => {
  it("uses the Forever XP table", () => {
    expect(xp.xpToNext(1)).toBe(400);
    expect(xp.xpToNext(59)).toBe(209800);
    expect(xp.xpToNext(60)).toBe(0);
    expect(xp.xpBetween(1, 60)).toBe(4084700); // matches the guide's total
  });
  it("computes mob XP with level differences", () => {
    expect(xp.mobXp(10, 10)).toBe(95);
    expect(xp.mobXp(10, 12)).toBe(105); // +10%
    expect(xp.mobXp(10, 20)).toBe(114); // capped at +4 levels
    expect(xp.mobXp(20, 15)).toBe(Math.round(145 * (1 - 5 / 11)));
    expect(xp.mobXp(20, xp.greyLevel(20))).toBe(0);
    expect(xp.mobXp(10, 10, { elite: true, rested: true })).toBe(380);
  });
  it("splits group XP with the size bonus", () => {
    expect(xp.mobXp(30, 30, { groupLevels: [30, 30, 30, 30, 30] })).toBe(Math.round(195 * 1.4 / 5));
  });
  it("caps the rested pool at 150% of a level", () => {
    const r = xp.restedPool(20, 10_000);
    expect(r.xp).toBe(Math.round(23200 * 1.5));
    expect(xp.restedPool(20, 8).xp).toBe(Math.round(23200 * 0.05));
  });
  it("penalises low quests", () => {
    expect(xp.questXpMultiplier(20, 15)).toBe(1);
    expect(xp.questXpMultiplier(20, 13)).toBe(0.6);
    expect(xp.questXpMultiplier(40, 10)).toBe(0.1);
  });
});

describe("stats", () => {
  it("normalises every common shape", () => {
    expect(normaliseStats({ Strength: 5, "Attack Power": 20, dps: 12.5 }).stats).toEqual({ str: 5, ap: 20, weapon_dps: 12.5 });
    expect(normaliseStats([{ type: { type: "STAMINA" }, value: 7 }]).stats).toEqual({ sta: 7 });
    expect(normaliseStats([{ type: "crit_rating", value: 1 }, { type: "damage_per_second", value: 30 }]).stats).toEqual({ crit: 1, weapon_dps: 30 });
    expect(normaliseStats({ Frostiness: 3 }).unknown).toEqual(["Frostiness"]);
  });
  it("scores with weights", () => {
    const w = weightsFor("warrior", "fury")!;
    const s = scoreStats({ str: 10, sta: 10 }, w);
    expect(s.score).toBe(26);
    expect(s.breakdown[0].stat).toBe("str");
    expect(weightsFor("hunter", "beast mastery")).toBeDefined();
  });
});

describe("confidence", () => {
  it("labels tiers", () => {
    expect(single({ tier: "official" }).label).toBe("high");
    expect(single({ tier: "game_files" }).label).toBe("medium");
    expect(single({ tier: "classic_baseline" }).label).toBe("low");
    expect(single({ tier: "player_observed", reporters: 8 }).score).toBe(0.9);
  });
  it("rewards agreement and punishes weak links", () => {
    expect(agree([{ tier: "game_files" }, { tier: "player_observed", reporters: 6 }]).score).toBe(0.85);
    expect(derived([{ tier: "official" }, { tier: "classic_baseline" }]).label).toBe("low");
  });
});

describe("gold", () => {
  it("formats copper", () => {
    expect(formatCopper(123456)).toBe("12g 34s 56c");
    expect(formatCopper(0)).toBe("0c");
    expect(formatCopper(null)).toBe("unknown");
    expect(netAfterCut(10000)).toBe(9500);
  });
});
