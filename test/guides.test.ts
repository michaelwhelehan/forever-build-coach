import { describe, it, expect } from "vitest";
import { parseGuide, pickSections, guideUrl, professionGuideUrl, parseSkillSteps, stepsFrom } from "../src/sources/guides.js";
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

describe("profession routes", () => {
  const html = `<html><head><title>Tailoring leveling</title></head><body><main><h1>Tailoring leveling guide</h1>
    <h2>Route</h2><ol>
    <li><strong>1-27: Bolt of Linen Cloth</strong>. Make about 26. Each needs 2 Linen Cloth.</li>
    <li><strong>27-73: Linen Belt</strong>. Make about 60. Each needs 1 Bolt of Linen Cloth, 1 Coarse Thread.</li>
    <li>Train Journeyman Tailoring before skill 75.</li>
    <li><strong>73-100: Heavy Linen Gloves</strong>. Make about 30.</li></ol>
    <h2>Shopping list</h2><ul><li>1,760 Runecloth</li><li>105 Coarse Thread</li></ul></main></body></html>`;
  const g = parseGuide(html, professionGuideUrl("Tailoring"));

  it("builds the url", () => {
    expect(professionGuideUrl("First Aid")).toBe("https://foreverdb.net/profession/first-aid/leveling");
  });
  it("splits the route into skill steps and keeps notes inside them", () => {
    const steps = parseSkillSteps(g);
    expect(steps.map((s) => `${s.from}-${s.to}`)).toEqual(["1-27", "27-73", "73-100"]);
    expect(steps[1].text).toContain("Train Journeyman");
    expect(steps[2].text).not.toContain("Runecloth");
  });
  it("starts from the current skill", () => {
    expect(stepsFrom(parseSkillSteps(g), 50, 2).map((s) => s.from)).toEqual([27, 73]);
    expect(stepsFrom(parseSkillSteps(g), 100)).toEqual([]);
  });
});

describe("subsections", () => {
  it("returns a heading's subsections with it", () => {
    const g = parseGuide(`<main><h2>What sells at levels 1-20</h2><p>Crafters need materials.</p><h3>Cloth</h3><p>Linen Cloth 13c</p><h3>Herbs</h3><p>Peacebloom 10c</p><h2>Timing</h2><p>Weekends.</p></main>`, "https://foreverdb.net/guide/making-money");
    const m = pickSections(g, "what sells", undefined, 1);
    expect(m[0].text).toContain("Linen Cloth 13c");
    expect(m[0].text).toContain("Peacebloom");
    expect(m[0].text).not.toContain("Weekends");
  });
});
