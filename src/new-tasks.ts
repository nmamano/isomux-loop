// The new-task wake-up (Nil, 2026-10-31, through Antifeed PM): Isomux
// decisions moved to the Isomux Inbox as asks, and the curator opens them.
// Every minute the app tells the curator about each open P0-P3 task with no
// [class | state] tag that it has not reported yet, in one message.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOOP_PRIORITIES, ROOM_ID } from "./config";
import { readJson, writeJson } from "./json-file";
import { parseTag } from "./loop";
import type { Office, Task } from "./office";

// Open P0-P3 tasks of the room with no tag that reported does not hold, oldest first.
export function unreported(tasks: Task[], reported: Record<string, string>): Task[] {
  return tasks
    .filter(
      (t) =>
        (t.roomId === undefined || t.roomId === ROOM_ID) &&
        t.status === "open" &&
        LOOP_PRIORITIES.includes(t.priority ?? "") &&
        parseTag(t.title) === null &&
        !(t.id in reported),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

// One line per task, the whole title.
export function newTasksText(tasks: Task[]): string {
  return "/isomux-curator New tasks for triage: " + tasks.map((t) => `${t.id} ${t.title.replace(/\s+/g, " ").trim()}`).join("\n");
}

export type NewTasksRun = { at: number; reported: string[]; seeded?: number; error?: string };

// reported: task id -> the version the app reported (a task is reported once).
export class NewTasks {
  private file: string;
  private reported: Record<string, string>;
  // No file yet: the first run takes the tasks it finds as reported, since
  // Antifeed reported them before this wake-up took over.
  private seeding: boolean;

  constructor(dataDir: string) {
    this.file = join(dataDir, "new-tasks.json");
    this.seeding = !existsSync(this.file);
    this.reported = readJson<Record<string, string>>(this.file, {});
  }

  async run(office: Office, now = Date.now()): Promise<NewTasksRun> {
    const found = unreported(await office.tasks(), this.reported);
    if (this.seeding) {
      for (const t of found) this.reported[t.id] = t.version;
      this.seeding = false;
      writeJson(this.file, this.reported);
      return { at: now, reported: [], seeded: found.length };
    }
    if (!found.length) return { at: now, reported: [] };
    // Not delivered: nothing is recorded, and the next minute tries again.
    if (!(await office.message(newTasksText(found)))) return { at: now, reported: [], error: "the message to the curator failed" };
    for (const t of found) this.reported[t.id] = t.version;
    writeJson(this.file, this.reported);
    return { at: now, reported: found.map((t) => t.id) };
  }
}
