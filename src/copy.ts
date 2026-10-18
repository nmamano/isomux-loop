// Copy waiting for Nil's sign-off: Isomux PM pushes {taskId, title, old, new},
// and the page shows old next to new at /copy/<taskId>, a link for an ask.

import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import { ValidationError } from "./store";

export type CopyItem = { taskId: string; title: string; old: string; new: string; updatedAt: number };

const MAX = 100_000;

function text(v: unknown, field: string, required: boolean): string {
  if (v === undefined || v === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return "";
  }
  if (typeof v !== "string") throw new ValidationError(`${field} must be a string`);
  if (v.length > MAX) throw new ValidationError(`${field} is longer than ${MAX} characters`);
  return v;
}

export class CopyStore {
  private file: string;
  private items: Record<string, CopyItem>;

  constructor(
    dataDir: string,
    private now: () => number = Date.now,
  ) {
    this.file = join(dataDir, "copy.json");
    this.items = readJson<Record<string, CopyItem>>(this.file, {});
  }

  // One entry per task; a new push replaces it. `old` is empty for new copy.
  put(raw: unknown): CopyItem {
    const r = (raw ?? {}) as Record<string, unknown>;
    const taskId = text(r.taskId, "taskId", true);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) throw new ValidationError("taskId must be a board task id");
    const item: CopyItem = {
      taskId,
      title: text(r.title, "title", true),
      old: text(r.old, "old", false),
      new: text(r.new, "new", true),
      updatedAt: this.now(),
    };
    this.items[taskId] = item;
    writeJson(this.file, this.items);
    return item;
  }

  get(taskId: string): CopyItem | undefined {
    return this.items[taskId];
  }

  list(): CopyItem[] {
    return Object.values(this.items).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(taskId: string): boolean {
    if (!this.items[taskId]) return false;
    delete this.items[taskId];
    writeJson(this.file, this.items);
    return true;
  }
}
