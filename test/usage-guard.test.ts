import { describe, expect, test } from "bun:test";
import { cap, fiveHour, UsageGuard } from "../src/usage-guard";
import { tempDir } from "./tmp";

const MIN = 60_000;
const T = 1_000_000_000;
const win = (usedPercent: number, minutesLeft: number | null) => ({ usedPercent, resetsAtMs: minutesLeft === null ? null : T + minutesLeft * MIN });

describe("5-hour guard", () => {
  test("reads the 5-hour window of a reading", () => {
    const r = { available: true as const, windows: [{ label: "Weekly", usedPercent: 48, resetsAtMs: 1 }, { label: "5-hour", usedPercent: 73, resetsAtMs: 2 }] };
    expect(fiveHour(r)).toMatchObject({ usedPercent: 73 });
    expect(fiveHour({ available: false, reason: "no_session" })).toBeNull();
  });

  test("the cap: 2 at 75% with more than an hour left, 1 at 90% whatever is left", () => {
    expect(cap(win(74, 200), T)).toBeNull();
    expect(cap(win(75, 61), T)).toBe(2);
    expect(cap(win(80, 59), T)).toBeNull();
    expect(cap(win(90, 5), T)).toBe(1);
  });

  test("lowers, lowers further, holds within the window, and puts the saved count back at the reset", () => {
    const dir = tempDir();
    const g = new UsageGuard(dir);
    expect(g.step(win(70, 200), 6, T)).toBeNull();
    expect(g.step(win(80, 200), 6, T)).toMatchObject({ set: 2 });
    expect(g.step(win(85, 190), 2, T + 10 * MIN)).toBeNull();
    expect(g.step(win(91, 100), 2, T + 20 * MIN)).toMatchObject({ set: 1 });
    // Use reads lower within the same window (or the reading fails): hold.
    expect(g.step(win(60, 90), 1, T + 30 * MIN)).toBeNull();
    expect(g.step(null, 1, T + 40 * MIN)).toBeNull();
    const again = new UsageGuard(dir);
    expect(again.lowered).toEqual({ saved: 6, to: 1, until: T + 100 * MIN });
    expect(again.step(null, 1, T + 100 * MIN)).toMatchObject({ set: 6 });
    expect(again.lowered).toBeNull();
    expect(again.log.map((e) => [e.from, e.to])).toEqual([[6, 2], [2, 1], [1, 6]]);
  });

  test("a reading of a later window ends the lowering before the old reset time is reached", () => {
    const g = new UsageGuard(tempDir());
    g.step(win(80, 200), 4, T);
    expect(g.step(win(5, 200 + 300), 2, T + 199 * MIN)).toMatchObject({ set: 4 });
  });

  test("a count set by hand while lowered wins: nothing is put back", () => {
    const g = new UsageGuard(tempDir());
    g.step(win(80, 200), 6, T);
    expect(g.step(win(80, 190), 4, T + 10 * MIN)).toBeNull();
    expect(g.lowered).toBeNull();
    expect(g.step(null, 4, T + 300 * MIN)).toBeNull();
  });

  test("a stale reading (its reset passed) changes nothing", () => {
    const g = new UsageGuard(tempDir());
    expect(g.step(win(95, -5), 6, T)).toBeNull();
    expect(g.lowered).toBeNull();
  });
});
