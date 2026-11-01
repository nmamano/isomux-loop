// Sign-off items the Sign-off Scout has not heard about yet (batchAsks, Nil,
// 2026-11-01): a merge with a waiting item joins the queue, and the hourly
// tick tells the Scout about all of them in one message, so its asks reach
// Nil's Inbox together. Kept on disk so a restart loses none.

import { join } from "node:path";
import { readJson, writeJson } from "./json-file";

export function scoutText(ids: string[]): string {
  const one = ids.length === 1;
  return (
    `/isomux-signoff-scout ${ids.join(", ")}: ${one ? "its merge is" : "their merges are"} on the loop app's Sign-off tab. ` +
    (one
      ? `Read it (GET 127.0.0.1:21025/api/signoff) and post your verdict: POST /api/signoff/${ids[0]}/scout.`
      : "Read them (GET 127.0.0.1:21025/api/signoff) and post your verdict for each: POST /api/signoff/<taskId>/scout.")
  );
}

export class ScoutQueue {
  private file: string;
  private ids: string[];

  constructor(dataDir: string) {
    this.file = join(dataDir, "scout-queue.json");
    this.ids = readJson<string[]>(this.file, []);
  }

  add(taskId: string): void {
    if (this.ids.includes(taskId)) return;
    this.ids.push(taskId);
    writeJson(this.file, this.ids);
  }

  // The queued items that still wait for Nil, in merge order; send tells the
  // Scout. The queue empties only when send delivered, so a failed message is
  // tried again at the next flush. An item that stopped waiting just leaves.
  async flush(waiting: (taskId: string) => boolean, send: (text: string) => Promise<boolean>): Promise<string[]> {
    const ids = this.ids.filter(waiting);
    if (ids.length && !(await send(scoutText(ids)))) {
      this.save(ids);
      throw new Error("the message to the Sign-off Scout failed");
    }
    this.save([]);
    return ids;
  }

  private save(ids: string[]): void {
    if (ids.length === this.ids.length && ids.every((x, k) => x === this.ids[k])) return;
    this.ids = ids;
    writeJson(this.file, ids);
  }
}
