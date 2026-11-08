import { describe, it, expect } from "vitest";
import { parseGuide, pickSections, guideUrl } from "../src/sources/guides.js";
import { parseExport } from "../src/addon-export.js";

const PAGE = `<html><head><title>Frost Mage Leveling Guide - WoW Forever</title></head><body><main>
<h1>Frost Mage Leveling Guide</h1>
<h2>Leveling Talents</h2><table><tr><th>Level</th><th>Talent</th></tr><tr><td>10-14</td><td>Improved Frostbolt <img alt="Improved Frostbolt"></td></tr><tr><td>15-17</td><td>Frostbite</td></tr></table>
<h2>Levels 10-20: Silverpine Forest</h2><ul><li>Quest in Silverpine until 18.</li><li>Run Shadowfang Keep at 18.</li></ul>
<h2>Levels 20-30: Hillsbrad Foothills</h2><p>Move to Tarren Mill.</p>
<h2>Rotation</h2><p>Frostbolt, then Fire Blast.</p>
</main></body></html>`;

describe("levelling guides", () => {
  it("builds the Icy Veins URL", () => {
    expect(guideUrl("mage", "frost")).toBe("https://www.icy-veins.com/wow-forever/frost-mage-leveling");
    expect(guideUrl("hunter", "beast mastery")).toBe("https://www.icy-veins.com/wow-forever/beast-mastery-hunter-leveling");
  });

  it("splits the page into sections and keeps tables and lists readable", () => {
    const g = parseGuide(PAGE, "u");
    expect(g.title).toBe("Frost Mage Leveling Guide");
    expect(g.sections.map((s) => s.heading)).toEqual(["Leveling Talents", "Levels 10-20: Silverpine Forest", "Levels 20-30: Hillsbrad Foothills", "Rotation"]);
    expect(g.sections[0].text).toContain("10-14 | Improved Frostbolt [Improved Frostbolt]");
    expect(g.sections[1].text).toContain("- Run Shadowfang Keep at 18.");
  });

  it("picks the talent section for talent questions and the level range for what-next", () => {
    const g = parseGuide(PAGE, "u");
    expect(pickSections(g, "which talent next", 15)[0].heading).toBe("Leveling Talents");
    expect(pickSections(g, "what should I do next", 15)[0].heading).toBe("Levels 10-20: Silverpine Forest");
    expect(pickSections(g, "rotation")[0].heading).toBe("Rotation");
  });
});

describe("addon export", () => {
  it("reads the line the addon shows", () => {
    expect(parseExport("FBC1:MAGE:15:Uzal:HEAD=0;BACK=2580;MAINHAND=4566;RANGED=11288;JUNK=1")).toEqual({
      class: "mage", level: 15, name: "Uzal", slots: { HEAD: 0, BACK: 2580, MAINHAND: 4566, RANGED: 11288 },
    });
    expect(() => parseExport("hello")).toThrow(/FBC1/);
  });
});
