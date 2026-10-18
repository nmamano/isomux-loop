// Loop settings, kept on disk so an app restart keeps them. Pause stops
// dispatch and the tick: workers on a batch outside the loop must not get loop
// messages. `workers` is N: the loop dispatches to Workers 1..N.

import { join } from "node:path";
import { DEFAULT_WORKERS, MAX_WORKERS } from "./config";
import { readJson, writeJson } from "./json-file";
import { ValidationError } from "./store";

type Settings = { paused: boolean; since: number | null; workers: number };

export class PauseFlag {
  private file: string;
  private state: Settings;

  constructor(dataDir: string) {
    this.file = join(dataDir, "pause.json");
    const loaded = readJson<Partial<Settings>>(this.file, {});
    this.state = {
      paused: loaded.paused ?? false,
      since: loaded.since ?? null,
      workers: loaded.workers ?? DEFAULT_WORKERS,
    };
  }

  get paused(): boolean {
    return this.state.paused;
  }

  get since(): number | null {
    return this.state.since;
  }

  get workers(): number {
    return this.state.workers;
  }

  set(paused: boolean, now = Date.now()): void {
    if (paused === this.state.paused) return;
    this.state = { ...this.state, paused, since: paused ? now : null };
    writeJson(this.file, this.state);
  }

  setWorkers(raw: unknown): void {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS)
      throw new ValidationError(`workers must be an integer from 1 to ${MAX_WORKERS}`);
    this.state = { ...this.state, workers: n };
    writeJson(this.file, this.state);
  }
}
