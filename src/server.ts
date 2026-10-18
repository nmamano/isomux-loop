import { page } from "./page";
import { Store, ValidationError } from "./store";

const port = Number(process.env.PORT);
const dataDir = process.env.ISOMUX_APP_DATA_DIR;
const appToken = process.env.ISOMUX_APP_TOKEN;
if (!Number.isInteger(port) || !dataDir || !appToken)
  throw new Error("required_app_environment_missing");

const OFFICE = "http://localhost:4000";
// Nil decides in bursts; the curator hears once he has paused this long.
const QUIET_MS = 3 * 60_000;
const local = `http://127.0.0.1:${port}`;

const store = new Store(dataDir);

const HELP = `Loop app: triage API (for the curator). Base: ${local}
GET  /api/summary                 counts per state
GET  /api/items?state=open|decided|applied|failed|all
POST /api/proposals               {"proposals":[{"taskId","task":{"title","description","priority","createdBy","createdAt"},"proposal":{"priority":"P0-P4","class":"auto|decide|taste|authority","outcome":"keep|rescope|obsolete","title?","scope?","why"}}]}
                                  task.* is the board task as it is now. A rescope needs proposal.title and/or proposal.scope.
                                  An item with a decision not yet applied is skipped; an applied item gets the new proposal and reopens.
DELETE /api/items/:taskId         withdraw a proposal (the task closed meanwhile)
GET  /api/decisions               decisions to write to the board (decided, or failed earlier)
POST /api/applied                 {"results":[{"taskId","decidedAt","ok":true|false,"error?"}]}
                                  decidedAt from /api/decisions; a decision Nil changed since then comes back as stale.
`;

async function message(text: string): Promise<"delivered" | "rejected" | "ambiguous"> {
  try {
    const res = await fetch(`${OFFICE}/api/app/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.error(`message_rejected status=${res.status}`);
    return res.ok ? "delivered" : "rejected";
  } catch {
    return "ambiguous";
  }
}

async function notifyTick(): Promise<void> {
  if (!store.shouldNotify(QUIET_MS)) return;
  const n = store.pending().length;
  const outcome = await message(
    `${n} triage decision${n === 1 ? "" : "s"} from Nil wait to be written to the board. ` +
      `Read them with curl -s ${local}/api/decisions, apply each one, then report with POST ${local}/api/applied. API: curl -s ${local}/api/help`,
  );
  // A rejection (no target, rate limit) is not retried until the next decision.
  if (outcome !== "ambiguous") store.markNotified();
}
setInterval(() => void notifyTick(), 30_000);

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

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = req.method;

  if (m === "GET" && path === "/")
    return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (m === "GET" && path === "/api/help") return new Response(HELP);
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
console.log(`loop app listening on ${port}`);
