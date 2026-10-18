// Pause stops dispatch only; the tick keeps running. Kept on disk so an app
// restart does not resume a loop Isomux PM paused.

import { join } from "node:path";
import { readJson, writeJson } from "./json-file";

export class PauseFlag {
  private file: string;
  private state: { paused: boolean; since: number | null };

  constructor(dataDir: string) {
    this.file = join(dataDir, "pause.json");
    this.state = readJson(this.file, { paused: false, since: null });
  }

  get paused(): boolean {
    return this.state.paused;
  }

  get since(): number | null {
    return this.state.since;
  }

  set(paused: boolean, now = Date.now()): void {
    if (paused === this.state.paused) return;
    this.state = { paused, since: paused ? now : null };
    writeJson(this.file, this.state);
  }
}
