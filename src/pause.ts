// Loop settings, kept on disk so an app restart keeps them. Pause stops
// dispatch and the tick: workers on a batch outside the loop must not get loop
// messages. `workers` is N: the loop dispatches to Workers 1..N. `minPriority`
// is the priority floor: dispatch takes only ready tasks at it or higher
// (null: no floor).

import { join } from "node:path";
import { DEFAULT_WORKERS, LOOP_PRIORITIES, MAX_WORKERS } from "./config";
import { readJson, writeJson } from "./json-file";
import { ValidationError } from "./store";

type Settings = { paused: boolean; since: number | null; workers: number; minPriority: string | null };

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
      minPriority: loaded.minPriority ?? null,
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

  get minPriority(): string | null {
    return this.state.minPriority;
  }

  set(paused: boolean, now = Date.now()): void {
    if (paused === this.state.paused) return;
    this.state = { ...this.state, paused, since: paused ? now : null };
    writeJson(this.file, this.state);
  }

  // Settings from POST /api/settings; an absent field keeps its value. Both
  // are checked before either is written.
  update(raw: { workers?: unknown; minPriority?: unknown }): void {
    const next = { ...this.state };
    if (raw.workers !== undefined) {
      const n = Number(raw.workers);
      if (!Number.isInteger(n) || n < 1 || n > MAX_WORKERS)
        throw new ValidationError(`workers must be an integer from 1 to ${MAX_WORKERS}`);
      next.workers = n;
    }
    if (raw.minPriority !== undefined) {
      const f = raw.minPriority;
      if (f !== null && (typeof f !== "string" || !LOOP_PRIORITIES.includes(f)))
        throw new ValidationError(`minPriority must be one of ${LOOP_PRIORITIES.join(", ")}, or null for no floor`);
      next.minPriority = f;
    }
    this.state = next;
    writeJson(this.file, this.state);
  }
}
