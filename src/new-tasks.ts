// The new-task wake-up (Nil, 2026-10-31, through Antifeed PM): Isomux
// decisions moved to the Isomux Inbox as asks, and the curator opens them.
// Every minute the app tells the curator, in one message, about each task that
// waits for triage and that it has not reported yet, and about each reported
// task that changed in a way that matters to its ask.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LOOP_PRIORITIES, ROOM_ID } from "./config";
import { readJson, writeJson } from "./json-file";
import { parseTag } from "./loop";
import type { Office, Task } from "./office";

// A task waits for triage when it is open in the room, nobody holds it, it
// has P0-P3 and its title has no [class | state] tag. A tagged, assigned,
// closed or P4 task does not wait (Isomux Curator, 2026-10-31).
export function waits(t: Task): boolean {
  return (
    (t.roomId === undefined || t.roomId === ROOM_ID) &&
    t.status === "open" &&
    !t.assignee &&
    LOOP_PRIORITIES.includes(t.priority ?? "") &&
    parseTag(t.title) === null
  );
}

// What the app knows of a reported task. text: a hash of the title and the
// description, the words an ask shows.
export type Seen = { version: string; text: string; waiting: boolean };
export type Reported = Record<string, Seen>;
export type Change = "stopped" | "waits again" | "edited";

const textOf = (t: Task) => createHash("sha256").update(`${t.title}\n${t.description ?? ""}`).digest("hex").slice(0, 16);
const seen = (t: Task): Seen => ({ version: t.version, text: textOf(t), waiting: waits(t) });

// The tasks that wait and that reported does not hold, oldest first.
export function unreported(tasks: Task[], reported: Reported): Task[] {
  return tasks.filter((t) => waits(t) && !(t.id in reported)).sort((a, b) => a.createdAt - b.createdAt);
}

// The reported tasks whose change matters to an ask (ported from the Wall
// Game copy, Wall Game Reviewer 1, 2026-10-31): it stopped waiting, waits
// again, or its title or description changed while it waits. A task that is
// not in the listing (done, obsolete, deleted or in another room) does not wait.
export function changes(tasks: Task[], reported: Reported): { id: string; change: Change; title: string }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: { id: string; change: Change; title: string }[] = [];
  for (const [id, before] of Object.entries(reported)) {
    const t = byId.get(id);
    const waiting = t ? waits(t) : false;
    const title = t ? t.title : "(not on the open board)";
    if (before.waiting && !waiting) out.push({ id, change: "stopped", title });
    else if (!before.waiting && waiting) out.push({ id, change: "waits again", title });
    else if (waiting && t && textOf(t) !== before.text) out.push({ id, change: "edited", title });
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// One line per task, the whole title; the same shape as the Wall Game copy.
export function newTasksText(news: Task[], changed: { id: string; change: Change; title: string }[] = []): string {
  const parts: string[] = [];
  if (news.length) parts.push("New tasks for triage: " + news.map((t) => `${t.id} ${oneLine(t.title)}`).join("\n"));
  if (changed.length) parts.push("Changed tasks: " + changed.map((c) => `${c.id} ${c.change} | ${oneLine(c.title)}`).join("\n"));
  return `/isomux-curator ${parts.join("\n")}`;
}

export type NewTasksRun = { at: number; reported: string[]; changed: string[]; seeded?: number; error?: string };

export class NewTasks {
  private file: string;
  private reported: Reported;
  // No file yet: the first run takes the tasks it finds as reported, since
  // Antifeed reported them before this wake-up took over.
  private seeding: boolean;
  // Entries from before changes() kept only a version: the next run records
  // what it sees of them and reports no change for them.
  private legacy: Set<string>;

  constructor(dataDir: string) {
    this.file = join(dataDir, "new-tasks.json");
    this.seeding = !existsSync(this.file);
    const raw = readJson<Record<string, Seen | string>>(this.file, {});
    this.legacy = new Set(Object.keys(raw).filter((id) => typeof raw[id] === "string"));
    this.reported = Object.fromEntries(
      Object.entries(raw).map(([id, r]) => [id, typeof r === "string" ? { version: r, text: "", waiting: false } : r]),
    );
  }

  async run(office: Office, now = Date.now()): Promise<NewTasksRun> {
    const tasks = await office.tasks();
    // An empty listing while reported tasks wait is more likely a lost room
    // access than a cleared board: record nothing, or every ask would go.
    if (!tasks.length && Object.values(this.reported).some((r) => r.waiting))
      throw new Error("the board listing is empty while reported tasks wait");
    const byId = new Map(tasks.map((t) => [t.id, t]));
    if (this.seeding || this.legacy.size) {
      const found = this.seeding ? unreported(tasks, this.reported) : [];
      for (const t of found) this.reported[t.id] = seen(t);
      for (const id of this.legacy) {
        const t = byId.get(id);
        this.reported[id] = t ? seen(t) : { ...this.reported[id], waiting: false };
      }
      const seeded = this.seeding ? found.length : undefined;
      this.seeding = false;
      this.legacy.clear();
      writeJson(this.file, this.reported);
      if (seeded !== undefined) return { at: now, reported: [], changed: [], seeded };
    }
    const news = unreported(tasks, this.reported);
    const changed = changes(tasks, this.reported);
    if (news.length || changed.length) {
      // Not delivered: nothing is recorded, and the next minute tries again.
      if (!(await office.message(newTasksText(news, changed))))
        return { at: now, reported: [], changed: [], error: "the message to the curator failed" };
    }
    // Record what the app saw of every reported task, also a change that does
    // not matter to an ask (a new priority, an edit while it does not wait).
    let dirty = news.length > 0;
    for (const t of news) this.reported[t.id] = seen(t);
    for (const [id, before] of Object.entries(this.reported)) {
      const t = byId.get(id);
      const after: Seen = t ? seen(t) : { ...before, waiting: false };
      if (after.version !== before.version || after.text !== before.text || after.waiting !== before.waiting) {
        this.reported[id] = after;
        dirty = true;
      }
    }
    if (dirty) writeJson(this.file, this.reported);
    return { at: now, reported: news.map((t) => t.id), changed: changed.map((c) => c.id) };
  }
}
