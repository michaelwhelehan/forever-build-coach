import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { parseArmoryPage, gearFromJson, mergeGear, shapeOf, type ArmoryCharacter, type ArmoryGear } from "./armory.js";

// Analytics and ads keep the network busy forever, so they're blocked rather than waited for.
const BLOCKED_HOST = /googletagmanager|google-analytics|doubleclick|facebook|twitter|hotjar|optimizely|onetrust|cookielaw|bat\.bing|scorecardresearch/i;
const BLOCKED_TYPE = new Set(["image", "media", "font", "stylesheet"]);

/** Runs in the page: equipped items the armory drew, read from item links and data attributes. */
const DOM_GEAR = `(() => {
  const out = [];
  const seen = new Set();
  const els = document.querySelectorAll('a[href*="item"], [data-item-id], [data-wowhead], [data-tooltip-href*="item"], [class*="Equipment"] [class*="Item"], [class*="equipment"] [class*="item"]');
  for (const el of els) {
    const attrs = [el.getAttribute('href'), el.getAttribute('data-item-id'), el.getAttribute('data-wowhead'), el.getAttribute('data-tooltip-href')].filter(Boolean).join(' ');
    const id = (attrs.match(/item[=/:-]?(\\d+)/i) || attrs.match(/^(\\d+)$/) || [])[1];
    const box = el.closest('[class*="Slot"], [class*="slot"], [data-slot]');
    const slot = box ? (box.getAttribute('data-slot') || (box.className.match(/(?:Slot|slot)[-_]?([A-Za-z]+)/) || [])[1]) : undefined;
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().split('\\n')[0];
    const key = (id || '') + '|' + name;
    if ((!id && !name) || seen.has(key)) continue;
    seen.add(key);
    out.push({ itemId: id ? Number(id) : undefined, name: name || undefined, slot, text: (el.innerText || '').trim().slice(0, 300) });
    if (out.length >= 30) break;
  }
  return out;
})()`;

export type RenderedArmory = ArmoryCharacter & { renderedText?: string; jsonResponses: number };

/**
 * Open the armory page in Cloudflare Browser Rendering, so the gear the page loads with
 * JavaScript is there. Gear is read, in order, from: the page's embedded data, the JSON the
 * page fetches, and the item links it draws. The rendered text comes back as a last resort.
 */
export async function renderArmory(binding: BrowserWorker, url: string): Promise<RenderedArmory> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
    await page.setRequestInterception(true);
    const requests: string[] = [];
    page.on("request", (req) => {
      const type = req.resourceType();
      if (BLOCKED_TYPE.has(type) || BLOCKED_HOST.test(req.url())) { req.abort().catch(() => {}); return; }
      if (type === "xhr" || type === "fetch" || type === "document" || type === "other") requests.push(`${req.method()} ${req.url()}`.slice(0, 300));
      req.continue().catch(() => {});
    });

    const json: { url: string; body: unknown }[] = [];
    let gearSeen: () => void = () => {};
    const gearArrived = new Promise<void>((r) => { gearSeen = r; });
    page.on("response", async (res) => {
      try {
        const type = res.headers()["content-type"] ?? "";
        if (!type.includes("json")) return;
        const body = await res.json();
        json.push({ url: res.url(), body });
        if (gearFromJson(body).equipped.length) gearSeen();
      } catch { /* not JSON after all, or body unavailable */ }
    });

    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (res && res.status() === 404) throw new Error("The armory has no page for that character. It must be level 10+, have logged out once, and be written as first name and surname.");

    // Wait for gear to show up: a JSON response with gear, or item links drawn on the page, up to 12 s.
    const drawn = page.waitForFunction(`document.querySelectorAll('a[href*="item"], [data-item-id], [data-wowhead]').length >= 2`, { timeout: 12_000 }).then(() => {}, () => {});
    await Promise.race([gearArrived, drawn, new Promise((r) => setTimeout(r, 12_000))]);
    await new Promise((r) => setTimeout(r, 750)); // let the last items render

    const html = await page.content();
    const text = String(await page.evaluate(`(document.querySelector("main") || document.body).innerText`)).replace(/\n{3,}/g, "\n\n").trim();
    const parsed = parseArmoryPage(html, url);
    // Gear can come from the embedded data and from the page's own requests; join them, one item per slot.
    const fetched = json.map((j) => ({ url: j.url, ...gearFromJson(j.body) })).filter((g) => g.equipped.length);
    const fromEmbedded = parsed.equipped.length;
    parsed.equipped = mergeGear([parsed.equipped, ...fetched.map((g) => g.equipped)]);
    parsed.class = parsed.class ?? fetched.find((g) => g.class)?.class;
    if (parsed.equipped.length) {
      parsed.gearSource = [fromEmbedded ? "embedded page data" : "", ...fetched.map((g) => `the page's data request ${g.url}`)].filter(Boolean).join(" + ") + " (rendered in a browser)";
    }
    // Items drawn on the page fill any slot the data missed (names and ids only).
    const dom = ((await page.evaluate(DOM_GEAR).catch(() => [])) as (ArmoryGear & { text?: string })[]).map((d) => ({ ...d, stats: {} }));
    const known = new Set(parsed.equipped.map((g) => g.itemId).filter(Boolean));
    const extra = dom.filter((d) => d.itemId && !known.has(d.itemId));
    if (!parsed.equipped.length && dom.length) {
      parsed.equipped = dom;
      parsed.gearSource = "item links drawn on the page (names and ids only; look stats up with item_lookup, or read them from renderedText)";
    } else if (extra.length) {
      parsed.equipped = [...parsed.equipped, ...extra.map(({ text, ...g }) => ({ ...g, slot: g.slot ?? "unknown (drawn on the page)" }))];
      parsed.gearSource += " + item links drawn on the page";
    }
    parsed.debug = {
      gearListSizes: [...(parsed.debug?.gearListSizes ?? []), ...fetched.flatMap((g) => g.lists)],
      stateShapes: [...(parsed.debug?.stateShapes ?? []), ...json.map((j) => ({ fetched: j.url, shape: shapeOf(j.body, 0, 4) }))],
      urls: parsed.debug?.urls ?? [],
      requests: requests.slice(0, 60),
      domItems: dom.map((d) => `${d.itemId ?? "?"} ${d.name ?? ""} [${d.slot ?? "?"}]`),
    };
    const statless = parsed.equipped.every((g) => !Object.keys(g.stats).length);
    return { ...parsed, jsonResponses: json.length, renderedText: statless ? text.slice(0, 6000) : undefined };
  } finally {
    await browser.close();
  }
}
