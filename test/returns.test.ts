import { describe, expect, test } from "bun:test";
import type { Office, Task } from "../src/office";
import { packetAuthor, Returns } from "../src/returns";
import { tempDir } from "./tmp";

const base: Task = { id: "abc12345", title: "[design | nil] T", status: "open", createdAt: 1, version: "v1" };
function office(last: { name: string; agentId?: string } | null | Error): Office {
  return {
    lastAssignee: async (_id: string, names: string[]) => {
      if (last instanceof Error) throw last;
      expect(names).toContain("Isomux Worker 1");
      return last;
    },
  } as unknown as Office;
}

describe("returns", () => {
  test("a record survives a restart and leaves on drop", () => {
    const dir = tempDir();
    const r = new Returns(dir);
    r.set("a", { name: "Isomux Worker 2", agentId: "id2" });
    r.set("b", { name: "Isomux Worker 3" });
    r.drop(["b", "unknown"]);
    const again = new Returns(dir);
    expect([again.get("a"), again.get("b"), again.ids()]).toEqual([{ name: "Isomux Worker 2", agentId: "id2" }, undefined, ["a"]]);
  });

  test("the author is the worker that holds the task, else the last worker in its history, else none", async () => {
    const held = { ...base, assignee: "Isomux Worker 4", assigneeAgentId: "id4" };
    expect(await packetAuthor(held, office(null))).toEqual({ name: "Isomux Worker 4", agentId: "id4" });
    expect(await packetAuthor({ ...base, assignee: "Isomux Curator" }, office({ name: "Isomux Worker 1", agentId: "id1" }))).toEqual({ name: "Isomux Worker 1", agentId: "id1" });
    expect(await packetAuthor(base, office(null))).toBeUndefined();
    expect(await packetAuthor(base, office(new Error("history 500")))).toBeUndefined();
  });
});
