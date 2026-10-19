// When each done or obsolete task was closed. The board has no update time,
// so the time comes from the task's history, read once per task version and
// cached on disk (a derived cache, rebuilt from the board if deleted).

import { join } from "node:path";
import { readJson, writeJson } from "./json-file";
import type { Office, Task } from "./office";

type Entry = { version: string; closedAt: number | null };

const CONCURRENCY = 4;

export class ClosedTimes {
  private file: string;
  private cache: Record<string, Entry>;
  private filling = false;
  private dirty = false;

  constructor(
    dataDir: string,
    private office: Office,
  ) {
    this.file = join(dataDir, "closed-times.json");
    this.cache = readJson<Record<string, Entry>>(this.file, {});
  }

  get(t: Task): number | undefined {
    const e = this.cache[t.id];
    return e && e.version === t.version && e.closedAt !== null ? e.closedAt : undefined;
  }

  missing(tasks: Task[]): Task[] {
    return tasks.filter(
      (t) => (t.status === "done" || t.status === "obsolete") && this.cache[t.id]?.version !== t.version,
    );
  }

  // Reads the histories the cache lacks, newest tasks first. One fill at a time.
  async fill(tasks: Task[]): Promise<number> {
    if (this.filling) return 0;
    this.filling = true;
    try {
      const queue = this.missing(tasks).sort((a, b) => b.createdAt - a.createdAt);
      let done = 0;
      const worker = async () => {
        while (queue.length > 0) {
          const t = queue.shift()!;
          try {
            this.cache[t.id] = { version: t.version, closedAt: await this.office.closedAt(t.id) };
            this.dirty = true;
            done++;
          } catch (err) {
            console.error(`history ${t.id}: ${String(err)}`);
          }
          if (done % 50 === 0) this.flush();
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      this.flush();
      return done;
    } finally {
      this.filling = false;
    }
  }

  private flush(): void {
    if (!this.dirty) return;
    writeJson(this.file, this.cache);
    this.dirty = false;
  }
}
