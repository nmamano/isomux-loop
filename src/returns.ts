// Who a task goes back to (Isomux PM's board task 8307e0fb, 2026-10-27): the
// worker that wrote a design packet holds its branch and context, so when Nil's
// decision makes the task ready again, dispatch gives it back to that worker.
// The record lives apart from the packet: the curator may withdraw the packet
// (Nil answered in the chat) and the task still goes back.

import { join } from "node:path";
import { WORKER_NAMES } from "./config";
import { readJson, writeJson } from "./json-file";
import type { Office, Task } from "./office";

// agentId: the worker's id when the board had it, so a new worker with a
// killed worker's name does not count as the author.
export type Author = { name: string; agentId?: string };

export class Returns {
  private file: string;
  private items: Record<string, Author>;

  constructor(dataDir: string) {
    this.file = join(dataDir, "returns.json");
    this.items = readJson<Record<string, Author>>(this.file, {});
  }

  get(taskId: string): Author | undefined {
    return this.items[taskId];
  }

  set(taskId: string, author: Author): void {
    this.items[taskId] = author;
    writeJson(this.file, this.items);
  }

  // Dispatch gave the task out, or the task closed or left the board.
  drop(taskIds: string[]): void {
    const gone = taskIds.filter((id) => id in this.items);
    if (!gone.length) return;
    for (const id of gone) delete this.items[id];
    writeJson(this.file, this.items);
  }

  ids(): string[] {
    return Object.keys(this.items);
  }
}

// A packet's author: the worker that holds the task when it posts, else the
// last worker the task's history names (it may clear the assignee first).
// Undefined when no worker did (a curator re-post): the old record stays.
export async function packetAuthor(t: Task, office: Office): Promise<Author | undefined> {
  if (t.assignee && WORKER_NAMES.includes(t.assignee))
    return { name: t.assignee, ...(t.assigneeAgentId ? { agentId: t.assigneeAgentId } : {}) };
  return (await office.lastAssignee(t.id, WORKER_NAMES).catch(() => null)) ?? undefined;
}
