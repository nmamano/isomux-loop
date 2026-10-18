import { DISPATCH_MS, STATUS_CACHE_MS, TICK_MS, TRIAGE_QUIET_MS } from "./config";
import { CopyStore } from "./copy";
import { dispatch, status, tick, type DispatchResult, type Status, type TickResult } from "./loop";
import { httpOffice } from "./office";
import { page } from "./page";
import { PauseFlag } from "./pause";
import { Store, ValidationError } from "./store";

const port = Number(process.env.PORT);
const dataDir = process.env.ISOMUX_APP_DATA_DIR;
const appToken = process.env.ISOMUX_APP_TOKEN;
if (!Number.isInteger(port) || !dataDir || !appToken)
  throw new Error("required_app_environment_missing");

const local = `http://127.0.0.1:${port}`;
const publicUrl = (process.env.ISOMUX_APP_URL || local).replace(/\/$/, "");

const office = httpOffice(appToken);
const store = new Store(dataDir);
const copy = new CopyStore(dataDir);
const pause = new PauseFlag(dataDir);

const HELP = `Loop app API. Base: ${local}

Triage (for the curator):
GET  /api/summary                 counts per state
GET  /api/items?state=open|decided|applied|failed|all
POST /api/proposals               {"proposals":[{"taskId","task":{"title","description","priority","createdBy","createdAt"},"proposal":{"priority":"P0-P4","class":"auto|decide|taste|authority","outcome":"keep|rescope|obsolete","title?","scope?","why"}}]}
                                  task.* is the board task as it is now. A rescope needs proposal.title and/or proposal.scope.
                                  An item with a decision not yet applied is skipped; an applied item gets the new proposal and reopens.
DELETE /api/items/:taskId         withdraw a proposal (the task closed meanwhile)
GET  /api/decisions               decisions to write to the board (decided, or failed earlier)
POST /api/applied                 {"results":[{"taskId","decidedAt","ok":true|false,"error?"}]}
                                  decidedAt from /api/decisions; a decision Nil changed since then comes back as stale.

Loop (for Isomux PM):
GET  /api/status                  pause state, last dispatch and tick, ready queue, holders, merging, parked
POST /api/pause | /api/resume     pause stops dispatch and the tick; the first tick after a resume catches what stopped meanwhile
POST /api/settings                {"workers": 1-6}: the loop dispatches to Workers 1..N (also on the status page).
                                  Lowering N takes no task away; a worker above N keeps its tick while it holds a loop task.
POST /api/dispatch | /api/tick    run one now (both refuse while paused)

Copy sign-off (for Isomux PM):
POST /api/copy                    {"taskId","title","old","new"}; old is "" for new copy. Answers {"url"}: the page for an ask.
GET  /api/copy | /api/copy/:taskId
DELETE /api/copy/:taskId          after Nil signed it off
`;

// --- loop timers -----------------------------------------------------------

type Run<T> = { at: number; result?: T; error?: string };
let lastDispatch: Run<DispatchResult> | null = null;
let lastTick: Run<TickResult> | null = null;
let busy = false;

async function exclusive<T>(fn: () => Promise<T>): Promise<Run<T> | null> {
  if (busy) return null;
  busy = true;
  const at = Date.now();
  try {
    return { at, result: await fn() };
  } catch (err) {
    console.error(err);
    return { at, error: String(err instanceof Error ? err.message : err) };
  } finally {
    busy = false;
  }
}

async function runDispatch(): Promise<Run<DispatchResult> | null> {
  if (pause.paused) return null;
  const run = await exclusive(() => dispatch(office, pause.workers));
  if (run) {
    lastDispatch = run;
    statusCache = null;
    if (run.result?.assigned.length) console.log(`dispatch ${JSON.stringify(run.result.assigned)}`);
  }
  return run;
}

async function runTick(): Promise<Run<TickResult> | null> {
  if (pause.paused) return null;
  const run = await exclusive(() => tick(office, pause.workers));
  if (run) lastTick = run;
  return run;
}

setInterval(() => void runDispatch(), DISPATCH_MS);
setInterval(() => void runTick(), TICK_MS);

// --- triage notifications ------------------------------------------------------

async function notifyTriage(): Promise<void> {
  if (!store.shouldNotify(TRIAGE_QUIET_MS)) return;
  const n = store.pending().length;
  const delivered = await office.message(
    `${n} triage decision${n === 1 ? "" : "s"} from Nil wait to be written to the board. ` +
      `Read them with curl -s ${local}/api/decisions, apply each one, then report with POST ${local}/api/applied. API: curl -s ${local}/api/help`,
  );
  // A rejection is not retried until the next decision.
  store.markNotified();
  if (!delivered) console.error("triage notification not delivered");
}
setInterval(() => void notifyTriage(), 30_000);

// --- status ------------------------------------------------------------------

let statusCache: { at: number; value: Status } | null = null;

async function loopStatus(): Promise<Record<string, unknown>> {
  let board: Status | null = null;
  let error: string | undefined;
  try {
    if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
      const [agents, tasks] = await Promise.all([office.agents(), office.tasks()]);
      statusCache = { at: Date.now(), value: status(agents, tasks, pause.workers) };
    }
    board = statusCache.value;
  } catch (err) {
    error = String(err instanceof Error ? err.message : err);
  }
  return { paused: pause.paused, pausedSince: pause.since, workers: pause.workers, lastDispatch, lastTick, board, error };
}

// --- HTTP --------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new ValidationError("body must be JSON");
  }
}

const html = () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;

  if (m === "GET" && (path === "/" || path.startsWith("/copy/"))) return html();
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (m === "GET" && path === "/api/help") return new Response(HELP);

  // Loop
  if (m === "GET" && path === "/api/status") return json(await loopStatus());
  if (m === "POST" && path === "/api/pause") {
    pause.set(true);
    return json({ paused: true });
  }
  if (m === "POST" && path === "/api/resume") {
    pause.set(false);
    return json({ paused: false });
  }
  if (m === "POST" && path === "/api/settings") {
    const b = await body(req);
    pause.setWorkers(b.workers);
    statusCache = null;
    return json({ workers: pause.workers });
  }
  if (m === "POST" && path === "/api/dispatch") {
    if (pause.paused) return json({ error: "paused" }, 409);
    const run = await runDispatch();
    return run ? json(run) : json({ error: "busy" }, 409);
  }
  if (m === "POST" && path === "/api/tick") {
    if (pause.paused) return json({ error: "paused" }, 409);
    const run = await runTick();
    return run ? json(run) : json({ error: "busy" }, 409);
  }

  // Copy
  if (m === "POST" && path === "/api/copy") {
    const item = copy.put(await body(req));
    return json({ ...item, url: `${publicUrl}/copy/${item.taskId}` });
  }
  if (m === "GET" && path === "/api/copy") return json(copy.list());
  const c = path.match(/^\/api\/copy\/([^/]+)$/);
  if (c) {
    const taskId = decodeURIComponent(c[1]);
    if (m === "GET") return copy.get(taskId) ? json(copy.get(taskId)) : json({ error: "not_found" }, 404);
    if (m === "DELETE") return copy.remove(taskId) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
  }

  // Triage
  if (m === "GET" && path === "/api/summary") return json(store.counts());
  if (m === "GET" && path === "/api/items") {
    const state = url.searchParams.get("state") ?? "all";
    if (!["open", "decided", "applied", "failed", "all"].includes(state))
      throw new ValidationError("unknown state");
    return json(store.list(state as "all"));
  }
  if (m === "POST" && path === "/api/proposals") {
    const b = await body(req);
    if (!Array.isArray(b.proposals)) throw new ValidationError("proposals must be an array");
    return json(store.propose(b.proposals));
  }
  if (m === "GET" && path === "/api/decisions") return json(store.pending());
  if (m === "POST" && path === "/api/applied") {
    const b = await body(req);
    if (!Array.isArray(b.results)) throw new ValidationError("results must be an array");
    return json(store.markApplied(b.results));
  }
  const item = path.match(/^\/api\/items\/([^/]+)(?:\/(decide|undo))?$/);
  if (item) {
    const taskId = decodeURIComponent(item[1]);
    const action = item[2];
    if (m === "DELETE" && !action)
      return store.withdraw(taskId) ? new Response(null, { status: 204 }) : json({ error: "not_found" }, 404);
    if (m === "POST" && action === "decide") return json(store.decide(taskId, await body(req)));
    if (m === "POST" && action === "undo") return json(store.undo(taskId));
  }
  return json({ error: "not_found" }, 404);
}

Bun.serve({
  port,
  hostname: process.env.ISOMUX_APP_HOST || "127.0.0.1",
  async fetch(req) {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof ValidationError) return json({ error: err.message }, 400);
      console.error(err);
      return json({ error: "internal" }, 500);
    }
  },
});
console.log(`loop app listening on ${port}${pause.paused ? " (paused)" : ""}`);
