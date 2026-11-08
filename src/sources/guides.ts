import type { BrowserWorker } from "@cloudflare/puppeteer";
import { TtlCache, HOUR, type KvLike } from "../cache.js";

/**
 * Levelling guides read on request and kept for a day (never copied into this repo). Icy Veins'
 * robots.txt allows /wow-forever/. Answers quote only the sections a question needs, with the link.
 */
export const GUIDE_HOSTS = ["www.icy-veins.com", "icy-veins.com", "foreverdb.net", "www.foreverdb.net"];

/** ForeverDB's step-by-step levelling route for a profession, e.g. /profession/tailoring/leveling. */
export function professionGuideUrl(profession: string): string {
  return `https://foreverdb.net/profession/${profession.toLowerCase().trim().replace(/[\s_]+/g, "-")}/leveling`;
}

/** ForeverDB's written guides, e.g. making-money. */
export const FOREVERDB_GUIDES = ["making-money", "professions", "best-professions-by-class"] as const;
export const foreverdbGuideUrl = (slug: string) => `https://foreverdb.net/guide/${slug}`;

const SPECS: Record<string, string[]> = {
  warrior: ["arms", "fury", "protection"], paladin: ["holy", "protection", "retribution"], hunter: ["beast-mastery", "marksmanship", "survival"],
  rogue: ["assassination", "combat", "subtlety"], priest: ["discipline", "holy", "shadow"], shaman: ["elemental", "enhancement", "restoration"],
  mage: ["arcane", "fire", "frost"], warlock: ["affliction", "demonology", "destruction"], druid: ["balance", "feral", "restoration"],
};

/** Icy Veins' Forever levelling guide for a class and spec, e.g. /wow-forever/frost-mage-leveling. */
export function guideUrl(cls: string, spec?: string): string {
  const s = (spec ?? SPECS[cls]?.[0] ?? "").toLowerCase().replace(/[\s_]+/g, "-");
  return `https://www.icy-veins.com/wow-forever/${s ? `${s}-` : ""}${cls.toLowerCase()}-leveling`;
}

export interface GuideSection { heading: string; level: number; text: string }
export interface Guide { url: string; title?: string; sections: GuideSection[]; fetchedAt: string; via: "fetch" | "browser" }

const decode = (s: string) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;/g, "'")
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&ndash;|&mdash;/g, "-").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

/** Visible text of an HTML fragment, keeping list items, table rows and image alt text (talent icons often carry the name there). */
function textOf(html: string): string {
  return decode(html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<img[^>]*\balt=["']([^"']+)["'][^>]*>/gi, " [$1] ")
    .replace(/<li[^>]*>/gi, "\n- ").replace(/<\/t[dh]>/gi, " | ").replace(/<br\s*\/?>|<\/(p|div|tr|li|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .split("\n").map((l) => l.replace(/\s+/g, " ").replace(/\s*\|\s*$/, "").trim()).filter(Boolean).join("\n");
}

/** Split a guide page into sections at its h2/h3/h4 headings. */
export function parseGuide(html: string, url: string, via: Guide["via"] = "fetch"): Guide {
  const title = decode(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "") || undefined;
  const main = html.match(/<(main|article)[^>]*>([\s\S]*)<\/\1>/i)?.[2] ?? html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const sections: GuideSection[] = [];
  const re = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const heads = [...main.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index! + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index! : main.length;
    const heading = textOf(heads[i][2]);
    const text = textOf(main.slice(start, end));
    if (heading && text) sections.push({ heading, level: Number(heads[i][1]), text });
  }
  // A page without subheadings is one section, so its text is still searchable.
  if (!sections.length) { const text = textOf(main); if (text) sections.push({ heading: title ?? url, level: 1, text }); }
  return { url, title, sections, fetchedAt: new Date().toISOString(), via };
}

export interface SkillStep { from: number; to: number; text: string }

/**
 * Skill-range steps of a profession route, e.g. "27-73: Linen Belt. Make about 60 ..." or a heading
 * "50-75". A step runs until the next range, so its text keeps the reagents and notes under it.
 * "Train Journeyman ..." lines stay inside the step they appear in.
 */
export function parseSkillSteps(g: Guide): SkillStep[] {
  const lines = g.sections.flatMap((s) => [s.heading, ...s.text.split("\n")]);
  const steps: SkillStep[] = [];
  let cur: SkillStep | undefined;
  for (const raw of lines) {
    const l = raw.replace(/^[-*\s]+/, "");
    const m = l.match(/^(?:skill\s*)?(\d{1,3})\s*[-–]\s*(\d{1,3})\b\s*[:.)]?/i);
    if (m && Number(m[1]) < Number(m[2]) && Number(m[2]) <= 375) {
      cur = { from: Number(m[1]), to: Number(m[2]), text: l };
      steps.push(cur);
    } else if (cur && /^(shopping list|best in slot|crafted items|trainers?)\b/i.test(l)) {
      cur = undefined; // the lists after the route aren't part of the last step
    } else if (cur && cur.text.length < 1200) cur.text += `\n${l}`;
  }
  return steps;
}

/** The steps from a skill onward: the one in progress first. */
export function stepsFrom(steps: SkillStep[], skill = 1, count = 4): SkillStep[] {
  const i = steps.findIndex((s) => s.to > skill);
  return i < 0 ? [] : steps.slice(i, i + count);
}

export interface GuideMatch { heading: string; text: string; why: string }

/** The sections that answer a question: words in the heading count most, then words and the player's level in the text. */
export function pickSections(g: Guide, question = "", level?: number, max = 3, maxChars = 3500): GuideMatch[] {
  const stop = new Set(["what", "should", "next", "the", "for", "and", "how", "do", "i", "my", "to", "a", "at", "is", "in", "of", "with", "now", "level", "lvl", "which", "where", "when", "get", "go"]);
  const words = question.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !stop.has(w)) ?? [];
  const wantsTalents = /talent|point|spec/.test(question.toLowerCase());
  const scored = g.sections.map((s) => {
    const h = s.heading.toLowerCase(), t = s.text.toLowerCase();
    let score = 0;
    const why: string[] = [];
    for (const w of words) { if (h.includes(w)) score += 5; else if (t.includes(w)) score += 1; }
    if (wantsTalents && /talent/.test(h)) { score += 8; why.push("talents"); }
    if (level !== undefined) {
      // "Level 15", "Levels 10-20", "10-20", "(15)" near the player's level.
      // A level range in the heading means the whole section is about those levels; in the text it's one line of it.
      const covers = (txt: string) => [...txt.matchAll(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/g)].some((m) => Number(m[1]) <= level && level <= Number(m[2]) && Number(m[2]) <= 60);
      if (covers(s.heading)) { score += 8; why.push(`section for level ${level}`); }
      else if (covers(s.text)) { score += 3; why.push(`covers level ${level}`); }
      if (new RegExp(`\\blevel ${level}\\b|\\b${level}:`, "i").test(s.text)) { score += 3; why.push(`mentions level ${level}`); }
    }
    if (words.some((w) => h.includes(w))) why.push("heading matches");
    return { s, score, why };
  });
  const picked = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max);
  return (picked.length ? picked : scored.slice(0, 1)).map(({ s, why }) => ({
    heading: s.heading,
    text: s.text.length > maxChars ? `${s.text.slice(0, maxChars)}… (more on the page)` : s.text,
    why: why.length ? [...new Set(why)].join(", ") : "start of the guide",
  }));
}

export class GuideError extends Error {}

export class Guides {
  private cache: TtlCache;
  constructor(kv?: KvLike, private browser?: BrowserWorker) {
    this.cache = new TtlCache(kv, "guide:");
  }

  get(url: string): Promise<Guide> {
    const host = new URL(url).hostname;
    if (!GUIDE_HOSTS.includes(host)) throw new GuideError(`Guides are read from ${GUIDE_HOSTS[0]} only.`);
    return this.cache.get(url, 24 * HOUR, async () => {
      const plain = await this.fetchPlain(url).catch((e: Error) => e);
      // Enough readable text means the page isn't drawn by JavaScript; otherwise open it in a browser.
      if (!(plain instanceof Error) && plain.sections.reduce((n, x) => n + x.text.length, 0) >= 1500) return plain;
      if (plain instanceof GuideError && /no guide/.test(plain.message)) throw plain;
      if (this.browser) return this.render(url);
      throw plain instanceof Error ? plain : new GuideError("The guide page had no sections this server could read.");
    });
  }

  private async fetchPlain(url: string): Promise<Guide> {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; forever-build-coach/0.4; fan-made build helper)", accept: "text/html" } });
    if (res.status === 404) throw new GuideError(`There's no guide at ${url}. The site may not have one for that yet.`);
    if (!res.ok) throw new GuideError(`The guide answered ${res.status}.`);
    return parseGuide(await res.text(), url, "fetch");
  }

  private async render(url: string): Promise<Guide> {
    const puppeteer = (await import("@cloudflare/puppeteer")).default;
    const browser = await puppeteer.launch(this.browser!);
    try {
      const page = await browser.newPage();
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
      await page.setRequestInterception(true);
      page.on("request", (req) => { if (["image", "media", "font"].includes(req.resourceType())) req.abort().catch(() => {}); else req.continue().catch(() => {}); });
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (res && res.status() === 404) throw new GuideError(`There's no guide at ${url}.`);
      await page.waitForSelector("h2", { timeout: 8_000 }).catch(() => {});
      return parseGuide(await page.content(), url, "browser");
    } finally {
      await browser.close();
    }
  }
}
