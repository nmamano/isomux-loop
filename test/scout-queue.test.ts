import { describe, expect, test } from "bun:test";
import { ScoutQueue } from "../src/scout-queue";
import { tempDir } from "./tmp";

describe("Scout queue (batchAsks)", () => {
  test("one message for every queued item that still waits, in merge order, once", async () => {
    const dir = tempDir();
    const q = new ScoutQueue(dir);
    for (const id of ["a1", "b2", "a1", "c3"]) q.add(id);
    const sent: string[] = [];
    const send = async (text: string) => (sent.push(text), true);
    // b2 was decided before the tick: it no longer waits.
    expect(await new ScoutQueue(dir).flush((id) => id !== "b2", send)).toEqual(["a1", "c3"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith("/isomux-signoff-scout a1, c3:")).toBe(true);
    expect(await new ScoutQueue(dir).flush(() => true, send)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test("a failed message keeps the items for the next flush", async () => {
    const dir = tempDir();
    const q = new ScoutQueue(dir);
    q.add("a1");
    q.add("b2");
    await expect(q.flush((id) => id === "a1", async () => false)).rejects.toThrow();
    const sent: string[] = [];
    expect(await new ScoutQueue(dir).flush(() => true, async (t) => (sent.push(t), true))).toEqual(["a1"]);
    expect(sent[0].startsWith("/isomux-signoff-scout a1:")).toBe(true);
  });
});
