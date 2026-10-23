import { describe, expect, test } from "bun:test";
import { PauseFlag } from "../src/pause";
import { ValidationError } from "../src/store";
import { tempDir } from "./tmp";

describe("worker count setting", () => {
  test("defaults to 2, accepts 1 to 6, keeps the pause state, and survives a reload", () => {
    const dir = tempDir();
    const p = new PauseFlag(dir);
    expect(p.workers).toBe(2);
    p.set(true, 7);
    p.update({ workers: 4 });
    const again = new PauseFlag(dir);
    expect([again.workers, again.paused, again.since]).toEqual([4, true, 7]);
    for (const bad of [0, 7, 2.5, "x", null]) expect(() => again.update({ workers: bad })).toThrow(ValidationError);
    expect(new PauseFlag(dir).workers).toBe(4);
  });
});

describe("priority floor setting", () => {
  test("defaults to no floor, takes P0-P3 or null, keeps the other settings, and survives a reload", () => {
    const dir = tempDir();
    const p = new PauseFlag(dir);
    expect(p.minPriority).toBeNull();
    p.set(true, 7);
    p.update({ workers: 2, minPriority: "P1" });
    const again = new PauseFlag(dir);
    expect([again.minPriority, again.workers, again.paused, again.since]).toEqual(["P1", 2, true, 7]);
    // An absent field keeps its value.
    again.update({ workers: 3 });
    expect(new PauseFlag(dir).minPriority).toBe("P1");
    for (const bad of ["P4", "p1", 1, "", {}]) expect(() => again.update({ minPriority: bad })).toThrow(ValidationError);
    // A bad field changes nothing, also the good one beside it.
    expect(() => again.update({ workers: 5, minPriority: "P9" })).toThrow(ValidationError);
    expect(() => again.update({ workers: 9, minPriority: "P0" })).toThrow(ValidationError);
    expect([new PauseFlag(dir).workers, new PauseFlag(dir).minPriority]).toEqual([3, "P1"]);
    again.update({ minPriority: null });
    expect(new PauseFlag(dir).minPriority).toBeNull();
  });
});

describe("pause", () => {
  test("survives a reload and records since when", () => {
    const dir = tempDir();
    const p = new PauseFlag(dir);
    expect(p.paused).toBe(false);
    p.set(true, 42);
    const again = new PauseFlag(dir);
    expect([again.paused, again.since]).toEqual([true, 42]);
    again.set(false);
    expect([new PauseFlag(dir).paused, new PauseFlag(dir).since]).toEqual([false, null]);
  });
});
