import { describe, expect, test } from "bun:test";
import { CopyStore } from "../src/copy";
import { PauseFlag } from "../src/pause";
import { ValidationError } from "../src/store";
import { tempDir } from "./tmp";

describe("copy", () => {
  test("one entry per task, replaced by a new push, kept across a reload, removable", () => {
    const dir = tempDir();
    const s = new CopyStore(dir, () => 5);
    s.put({ taskId: "abc123", title: "Docs line", old: "a", new: "b" });
    s.put({ taskId: "abc123", title: "Docs line", old: "a", new: "c" });
    expect(new CopyStore(dir).list().map((c) => c.new)).toEqual(["c"]);
    expect(s.remove("abc123")).toBe(true);
    expect(new CopyStore(dir).list()).toEqual([]);
  });

  test("new copy has an empty old text; a bad task id or missing text is refused", () => {
    const s = new CopyStore(tempDir());
    expect(s.put({ taskId: "abc", title: "T", new: "n" }).old).toBe("");
    expect(() => s.put({ taskId: "../x", title: "T", new: "n" })).toThrow(ValidationError);
    expect(() => s.put({ taskId: "abc", title: "T" })).toThrow(ValidationError);
  });
});

describe("worker count setting", () => {
  test("defaults to 2, accepts 1 to 6, keeps the pause state, and survives a reload", () => {
    const dir = tempDir();
    const p = new PauseFlag(dir);
    expect(p.workers).toBe(2);
    p.set(true, 7);
    p.setWorkers(4);
    const again = new PauseFlag(dir);
    expect([again.workers, again.paused, again.since]).toEqual([4, true, 7]);
    for (const bad of [0, 7, 2.5, "x", null]) expect(() => again.setWorkers(bad)).toThrow(ValidationError);
    expect(new PauseFlag(dir).workers).toBe(4);
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
