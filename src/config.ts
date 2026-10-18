// Constants of this office's loop (design: isomux internal-docs/continuous-loop-design.md).

export const OFFICE = "http://localhost:4000";
export const ROOM_ID = "e6818e47";
// The loop uses Workers 1..N; Nil sets N on the status page (1 to MAX_WORKERS).
export const WORKER_NAMES = [1, 2, 3, 4, 5, 6].map((n) => `Isomux Worker ${n}`);
export const MAX_WORKERS = WORKER_NAMES.length;
export const DEFAULT_WORKERS = 2;
export const MAIN_NAME = "Isomux Main";

export const DISPATCH_MS = 2 * 60_000;
export const TICK_MS = 60 * 60_000;
// Nil decides in bursts; the curator hears once he has paused this long.
export const TRIAGE_QUIET_MS = 3 * 60_000;
// The status view reads the board at most this often.
export const STATUS_CACHE_MS = 20_000;
