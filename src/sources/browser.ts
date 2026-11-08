import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { parseArmoryPage, gearFromJson, type ArmoryCharacter } from "./armory.js";

/**
 * Open the armory page in Cloudflare Browser Rendering, so the gear the page loads with
 * JavaScript is there. Keeps every JSON response the page fetches (the gear usually comes
 * from one) and the rendered text as a last resort for Claude to read.
 */
export async function renderArmory(binding: BrowserWorker, url: string): Promise<ArmoryCharacter & { renderedText?: string; jsonResponses: number }> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 forever-build-coach");
    const json: unknown[] = [];
    page.on("response", async (res) => {
      try {
        if (!(res.headers()["content-type"] ?? "").includes("json")) return;
        json.push(await res.json());
      } catch { /* not JSON after all, or body unavailable */ }
    });
    const res = await page.goto(url, { waitUntil: "networkidle0", timeout: 25_000 });
    if (res && res.status() === 404) throw new Error("The armory has no page for that character. It must be level 10+, have logged out once, and be written as first name and surname.");
    const html = await page.content();
    // Runs in the page: the visible text of the main content.
    const text = String(await page.evaluate(`(document.querySelector("main") || document.body).innerText`)).replace(/\n{3,}/g, "\n\n").trim();
    const parsed = parseArmoryPage(html, url);
    if (!parsed.equipped.length) {
      for (const j of json) {
        const g = gearFromJson(j);
        if (g.equipped.length) { parsed.equipped = g.equipped; parsed.class = parsed.class ?? g.class; parsed.gearSource = "page's own data requests (rendered in a browser)"; break; }
      }
    } else parsed.gearSource = "embedded page data (rendered in a browser)";
    return { ...parsed, jsonResponses: json.length, renderedText: parsed.equipped.length ? undefined : text.slice(0, 6000) };
  } finally {
    await browser.close();
  }
}
