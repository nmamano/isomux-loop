import { DISPATCH_MS, MAIN_NAME, ROOM_ID, STATUS_CACHE_MS, TICK_MS, TRIAGE_QUIET_MS } from "./config";
import { ClosedTimes } from "./closed-times";
import { type ImageDir } from "./images";
import { dispatch, status, tick, type DispatchResult, type Status, type TickResult } from "./loop";
import { httpOffice } from "./office";
import { page } from "./page";
import { PacketStore, packetState } from "./packets";
import { PauseFlag } from "./pause";
import { SignoffStore, signoffState } from "./signoff";
import { stateViews, type StateKey, type StateView } from "./states";
import { itemState, Store, ValidationError } from "./store";

const port = Number(process.env.PORT);
const dataDir = process.env.ISOMUX_APP_DATA_DIR;
const appToken = process.env.ISOMUX_APP_TOKEN;
if (!Number.isInteger(port) || !dataDir || !appToken)
  throw new Error("required_app_environment_missing");

const local = `http://127.0.0.1:${port}`;
const publicUrl = (process.env.ISOMUX_APP_URL || local).replace(/\/$/, "");

const office = httpOffice(appToken);
const store = new Store(dataDir);
const packets = new PacketStore(dataDir);
const signoff = new SignoffStore(dataDir);
const pause = new PauseFlag(dataDir);
const closed = new ClosedTimes(dataDir, office);

const HELP = `Loop app API. Base: ${local}

Triage (for the curator):
GET  /api/summary                 counts per state
GET  /api/items?state=open|decided|applied|failed|all
POST /api/proposals               {"proposals":[{"taskId","task":{"title","description","priority","createdBy","createdAt"},"proposal":{"priority":"P0-P4","class":"auto|decide|authority","outcome":"keep|rescope|obsolete","title?","scope?","why"}}]}
                                  task.* is the board task as it is now. A rescope needs proposal.title and/or proposal.scope.
                                  An item with a decision not yet applied is skipped; an applied item gets the new proposal and reopens.
DELETE /api/items/:taskId         withdraw a proposal (the task closed meanwhile)
GET  /api/decisions               decisions to write to the board (decided, or failed earlier), triage and packets:
                                  each has "kind": "triage" (decision: priority, class, outcome, note) or
                                  "packet" (decision: choice = an option label, "rescope", "obsolete" or "research more"; note)
POST /api/applied                 {"results":[{"taskId","decidedAt","kind?":"triage|packet","ok":true|false,"error?"}]}
                                  decidedAt from /api/decisions; a decision Nil changed since then comes back as stale.

Packets (for workers; a decision card for Nil in Triage):
POST /api/packets                 {"taskId","question","options":[{"label","cost","recommended":true|false}] (2-4, at most one
                                  recommended),"body":"markdown","branch?","diffUrl?"}. A new packet replaces the task's old one.
POST /api/packets/:taskId/images  raw PNG/JPEG/WebP bytes, ?caption=..., one per call, at most 5 MB, 20 per packet
GET  /api/packets                 all packets with their state

Loop (for Isomux PM):
GET  /api/status                  pause state, last dispatch and tick, ready queue, holders, merging, and the
                                  ten task states (board.states) with counts and tasks; done/obsolete list the last 20
POST /api/pause | /api/resume     pause stops dispatch and the tick; the first tick after a resume catches what stopped meanwhile
POST /api/settings                {"workers": 1-6}: the loop dispatches to Workers 1..N (also on the status page).
                                  Lowering N takes no task away; a worker above N keeps its tick while it holds a loop task.
POST /api/dispatch | /api/tick    run one now (both refuse while paused)

Sign-off before the push:
POST /api/signoff                 worker at hand-off: {"taskId","title","summary?","copy":[{"where","old","new"}]}
                                  (old "" for new copy). Replaces the task's item unless Nil rejected it and the revert is not reported.
POST /api/signoff/:taskId/images  raw PNG/JPEG/WebP bytes, ?caption=..., as for packets. For a before/after pair add
                                  ?pair=<short name>&side=before|after (one image per side); a pair shows side by side.
POST /api/signoff/:taskId/merged  Isomux Main after EVERY merge, item or not: {"commit"}. The sha is what a push go names.
POST /api/signoff/:taskId/reverted  Isomux Main after a revert Nil asked for: {"commit"}. The item leaves the list.
GET  /api/signoff                 merged items, the main sha, and whether a push go is possible
Nil's buttons on the Sign-off tab: approve; request edits (needs a comment on at least one entry: the app files a P0
"[auto | ready] Copy edits: <title>" task with the comments, and the item blocks the push until that task's own
sign-off item is merged and decided); reject (a note, plus any comments; messages Main "/isomux-main revert ...");
and "Approve and push" (messages Main "/isomux-main push go ..."). Comments are saved as Nil types
(POST /api/signoff/:taskId/comments {"copy":{"0":"..."},"images":{"0":"..."}}).
The app cannot tell which member pressed them.
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
  if (!store.shouldNotify(TRIAGE_QUIET_MS, packets.pending().length)) return;
  const n = store.pending().length + packets.pending().length;
  const delivered = await office.message(
    `${n} decision${n === 1 ? "" : "s"} from Nil (triage and packets) wait to be written to the board. ` +
      `Read them with curl -s ${local}/api/decisions, apply each one, then report with POST ${local}/api/applied. API: curl -s ${local}/api/help`,
  );
  // A rejection is not retried until the next decision.
  store.markNotified();
  if (!delivered) console.error("triage notification not delivered");
}
setInterval(() => void notifyTriage(), 30_000);

// --- status ------------------------------------------------------------------

type Board = Status & { states: Record<StateKey, StateView>; closedPending: number };
let statusCache: { at: number; value: Board } | null = null;

async function loopStatus(): Promise<Record<string, unknown>> {
  let board: Board | null = null;
  let error: string | undefined;
  try {
    if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
      const [agents, all] = await Promise.all([office.agents(), office.allTasks()]);
      // The dispatch view sees what dispatch sees: the board's default listing.
      const live = all.filter((t) => (t.status === "open" || t.status === "in_progress") && t.priority !== "P4");
      const cards = new Set(store.list("all").filter((i) => itemState(i) !== "applied").map((i) => i.taskId));
      for (const id of packets.unapplied()) cards.add(id);
      statusCache = {
        at: Date.now(),
        value: {
          ...status(agents, live, pause.workers),
          states: stateViews(
            all,
            cards,
            (t) => closed.get(t),
            new Set(signoff.visible().filter((i) => ["waiting", "edits", "rejected"].includes(signoffState(i))).map((i) => i.taskId)),
          ),
          closedPending: closed.missing(all).length,
        },
      };
      // Close times the cache lacks fill in the background; the next read shows them.
      void closed.fill(all).then((n) => {
        if (n > 0) statusCache = null;
      });
    }
    board = statusCache.value;
  } catch (err) {
    error = String(err instanceof Error ? err.message : err);
  }
  const signoffWaiting = signoff.visible().filter((i) => signoffState(i) === "waiting").length;
  return { paused: pause.paused, pausedSince: pause.since, workers: pause.workers, lastDispatch, lastTick, board, error, signoffWaiting };
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

async function mainAgentId(): Promise<string> {
  const main = (await office.agents()).find((a) => a.name === MAIN_NAME);
  if (!main) throw new ValidationError(`${MAIN_NAME} is not in the office`);
  return main.id;
}

type ImageTarget = { addImage: (id: string, b: Uint8Array, c: string, pair?: string | null, side?: string | null) => unknown };
async function imageUpload(req: Request, dir: ImageTarget, taskId: string, withPairs = false) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  const q = new URL(req.url).searchParams;
  if (!withPairs && (q.has("pair") || q.has("side"))) throw new ValidationError("before/after pairs are for sign-off images");
  return dir.addImage(taskId, bytes, q.get("caption") ?? "", q.get("pair"), q.get("side"));
}

function serveImage(images: ImageDir, taskId: string, file: string): Response {
  const bytes = images.read(taskId, file);
  if (!bytes) return json({ error: "not_found" }, 404);
  const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : "image/webp";
  return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
}

const html = () => new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;

  if (m === "GET" && (path === "/" || path.startsWith("/signoff/"))) return html();
  const img = path.match(/^\/img\/(packets|signoff)\/([^/]+)\/([^/]+)$/);
  if (m === "GET" && img)
    return serveImage(img[1] === "packets" ? packets.images : signoff.images, decodeURIComponent(img[2]), img[3]);
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

  // Packets
  if (m === "POST" && path === "/api/packets") {
    const b = await body(req);
    const taskId = String(b.taskId ?? "");
    let task: { title: string; priority: string | null };
    try {
      const t = await office.task(taskId);
      task = { title: t.title, priority: t.priority ?? null };
    } catch {
      throw new ValidationError(`task ${taskId} is not on the board (or the board is unreadable)`);
    }
    const p = packets.put(b, task);
    statusCache = null;
    return json({ ...p, url: publicUrl + "/" });
  }
  if (m === "GET" && path === "/api/packets") return json(packets.list().map((p) => ({ ...p, state: packetState(p) })));
  const pk = path.match(/^\/api\/packets\/([^/]+)\/(images|decide|undo)$/);
  if (pk && m === "POST") {
    const taskId = decodeURIComponent(pk[1]);
    if (pk[2] === "images") return json(await imageUpload(req, packets, taskId));
    if (pk[2] === "decide") {
      const p = packets.decide(taskId, await body(req));
      store.noteDecision(p.decision!.decidedAt);
      return json(p);
    }
    return json(packets.undo(taskId));
  }

  // Sign-off
  if (m === "GET" && path === "/api/signoff")
    return json({
      items: signoff.visible().map((i) => ({ ...i, state: signoffState(i), editsSettled: signoff.editsSettled(i) })),
      ...signoff.meta(),
      push: signoff.pushCheck(),
    });
  if (m === "POST" && path === "/api/signoff") return json(signoff.put(await body(req)));
  if (m === "POST" && path === "/api/signoff/push") {
    const check = signoff.pushCheck();
    if (!check.ok) return json({ error: check.reason }, 409);
    const text =
      `/isomux-main push go from Nil through the loop app: push main at ${check.sha}. ` +
      `Signed off: ${check.approved.length ? check.approved.join(", ") : "none (no copy or visible change waited)"}.`;
    if (!(await office.message(text, await mainAgentId()))) return json({ error: "the message to Isomux Main failed; nothing changed" }, 502);
    signoff.recordPushGo(check.sha!);
    return json({ sent: text });
  }
  const so = path.match(/^\/api\/signoff\/([^/]+)\/(images|merged|reverted|approve|reject|undo|comments|edits)$/);
  if (so && m === "POST") {
    const taskId = decodeURIComponent(so[1]);
    switch (so[2]) {
      case "images":
        return json(await imageUpload(req, signoff, taskId, true));
      case "merged":
        return json(signoff.merged(taskId, await body(req)));
      case "reverted":
        return json(signoff.reverted(taskId, await body(req)));
      case "approve":
        return json(signoff.approve(taskId));
      case "undo":
        return json(signoff.undo(taskId));
      case "comments":
        return json(signoff.setComments(taskId, await body(req)));
      case "edits": {
        const item = signoff.checkEdits(taskId);
        const title = item.title.replace(/^\[[^\]]*\]\s*/, "");
        const description = [
          `Copy edits Nil requested at sign-off in the loop app (${new Date().toISOString().slice(0, 10)}).`,
          `Source task: ${item.taskId}. Merged commit: ${item.merged!.commit}.`,
          "",
          "Rule: Nil's quoted text goes in verbatim; for a note, write the edit and create a sign-off item for it.",
          "",
          ...signoff.commentLines(item, true),
        ].join("\n");
        let created;
        try {
          created = await office.createTask({ title: `[auto | ready] Copy edits: ${title}`, description, priority: "P0", roomId: ROOM_ID });
        } catch (err) {
          return json({ error: `the board refused the edits task (${String(err instanceof Error ? err.message : err)}); nothing changed` }, 502);
        }
        statusCache = null;
        return json(signoff.recordEdits(taskId, created.id));
      }
      case "reject": {
        const { item, note } = signoff.checkReject(taskId, await body(req));
        const text = `/isomux-main revert ${taskId} (${item.merged!.commit}): Nil rejected it at sign-off: ${note}`;
        if (!(await office.message(text, await mainAgentId())))
          return json({ error: "the message to Isomux Main failed; the item is not rejected yet" }, 502);
        return json(signoff.recordReject(taskId, note));
      }
    }
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
  if (m === "GET" && path === "/api/decisions")
    return json([
      ...store.pending().map((i) => ({ kind: "triage", ...i })),
      ...packets.pending().map((p) => ({ kind: "packet", ...p })),
    ]);
  if (m === "POST" && path === "/api/applied") {
    const b = await body(req);
    if (!Array.isArray(b.results)) throw new ValidationError("results must be an array");
    const out = { recorded: [] as string[], stale: [] as string[] };
    for (const r of b.results as Record<string, unknown>[]) {
      const taskId = String(r?.taskId ?? "");
      let ok = false;
      if (r?.kind !== "packet") ok = store.markApplied([r]).recorded.length === 1;
      if (!ok && r?.kind !== "triage")
        ok = packets.markApplied(taskId, Number(r?.decidedAt), r?.ok !== false, typeof r?.error === "string" ? r.error : undefined);
      (ok ? out.recorded : out.stale).push(taskId);
    }
    return json(out);
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
