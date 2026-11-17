import { describe, expect, it } from "vitest";
import { blocksFromStamps, blocksToEvents, calcDay, newBlock, requiredBreak } from "./dayEdit";

const t = (iso: string) => iso.slice(11, 16);
const s = (event_type: string, hm: string) => ({ event_type, recorded_at: `2026-11-16T${hm}:00Z` });

describe("Tag korrigieren: automatische Pause", () => {
  it("Pflichtpause wie in der Datenbank", () => {
    expect(requiredBreak(360)).toBe(0);
    expect(requiredBreak(375)).toBe(15);
    expect(requiredBreak(480)).toBe(30);
    expect(requiredBreak(600)).toBe(45);
  });
  it("Pausen-Stempel fallen weg, Kommen/Gehen bleiben (Fall Djam: 12:54–21:28)", () => {
    const blocks = blocksFromStamps([s("clock_in", "12:54"), s("break_start", "21:28"), s("break_end", "21:28"), s("clock_out", "21:28")], t);
    expect(blocks.map((b) => [b.from, b.to])).toEqual([["12:54", "21:28"]]);
    const c = calcDay(blocks);
    expect(c.presence).toBe(514);
    expect(c.autoBreak).toBe(30);
    expect(c.counted).toBe(484);
    expect(blocksToEvents(blocks).map((e) => e.event)).toEqual(["clock_in", "clock_out"]);
  });
  it("Splitschicht: Lücke ab 15 Min. zählt als Pause", () => {
    const c = calcDay([newBlock("08:00", "12:00"), newBlock("13:00", "17:00")]);
    expect(c.presence).toBe(480);
    expect(c.autoBreak).toBe(0); // 60 Min. Lücke deckt die 30 Min. Pflichtpause
  });
  it("Fehler: Gehen vor Kommen, fehlende Zeit, Überschneidung", () => {
    expect(calcDay([newBlock("15:00", "09:00")]).problem).toContain("muss nach");
    expect(calcDay([newBlock("09:00", "")]).problem).toContain("Kommen und Gehen");
    expect(calcDay([newBlock("09:00", "13:00"), newBlock("12:00", "16:00")]).problem).toContain("überschneiden");
  });
});
