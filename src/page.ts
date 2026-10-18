// The triage page: one card per proposal, made for the phone.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loop · Triage</title>
<style>
  :root {
    --bg: #f6f5f2; --card: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #e3e1dc;
    --accent: #2f6fde; --accent-fg: #fff; --chip: #efeee9; --warn: #b4441c; --ok: #2e7d4f;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #151517; --card: #1f1f22; --fg: #ececee; --muted: #9a9aa2; --line: #313136;
      --accent: #5b8ef0; --accent-fg: #fff; --chip: #2a2a2f; --warn: #f08a5d; --ok: #6cc28f;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 2; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 10px 14px 0; }
  h1 { font-size: 17px; margin: 0 0 8px; }
  nav { display: flex; gap: 4px; overflow-x: auto; }
  nav button { border: 0; background: none; color: var(--muted); padding: 8px 10px;
    font: inherit; border-bottom: 2px solid transparent; white-space: nowrap; cursor: pointer; }
  nav button.on { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
  main { max-width: 720px; margin: 0 auto; padding: 12px; }
  .empty { color: var(--muted); text-align: center; padding: 40px 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 14px; margin-bottom: 12px; }
  .meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .title { font-weight: 600; margin: 6px 0; overflow-wrap: anywhere; }
  .why { margin: 8px 0; }
  .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .rescope { border-left: 3px solid var(--accent); padding-left: 10px; margin: 8px 0; }
  details { margin: 6px 0; }
  summary { color: var(--muted); cursor: pointer; font-size: 13px; }
  .desc { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; margin-top: 6px;
    max-height: 50vh; overflow: auto; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
  .row .label { flex-basis: 100%; }
  .chip { border: 1px solid var(--line); background: var(--chip); color: var(--fg); border-radius: 999px;
    padding: 6px 11px; font: inherit; font-size: 14px; cursor: pointer; min-height: 34px; }
  .chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .chip.proposed:not(.on) { border-color: var(--accent); }
  textarea { width: 100%; font: inherit; font-size: 14px; color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 8px; resize: vertical; min-height: 38px; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  .btn { border: 0; border-radius: 10px; padding: 10px 16px; font: inherit; font-weight: 600; cursor: pointer; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); flex: 1; }
  .btn.ghost { background: var(--chip); color: var(--fg); }
  .err { color: var(--warn); font-size: 13px; margin-top: 6px; }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>Loop · Triage</h1>
  <nav id="tabs"></nav>
</header>
<main id="list"></main>
<script>
const PRIORITIES = ["P0","P1","P2","P3","P4"];
const CLASSES = ["auto","decide","taste","authority"];
const OUTCOMES = ["keep","rescope","obsolete"];
const TABS = [["open","To review"],["decided","Decided"],["applied","Applied"]];
let tab = "open";
let items = [];
let counts = {};
const later = new Set();
const picks = {};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function age(ms) {
  if (!ms) return "";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d + " d old";
}
async function api(path, opts) {
  const res = await fetch(path, opts && { method: opts.method,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body ?? {}) });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data && data.error || res.statusText);
  return data;
}
async function load() {
  counts = await api("/api/summary");
  items = await api("/api/items?state=all");
  render();
}
function inTab(i) {
  const s = state(i);
  if (tab === "decided") return s === "decided" || s === "failed";
  return s === tab;
}
function state(i) {
  if (!i.decision) return "open";
  if (i.applied && i.applied.decidedAt === i.decision.decidedAt) return i.applied.ok ? "applied" : "failed";
  return "decided";
}
function renderTabs() {
  const n = { open: counts.open || 0, decided: (counts.decided || 0) + (counts.failed || 0), applied: counts.applied || 0 };
  document.getElementById("tabs").innerHTML = TABS.map(([k, label]) =>
    '<button class="' + (k === tab ? "on" : "") + '" data-tab="' + k + '">' + label + " (" + n[k] + ")</button>").join("");
}
function chips(kind, list, chosen, proposed, id) {
  return list.map(v => '<button class="chip' + (v === chosen ? " on" : "") + (v === proposed ? " proposed" : "") +
    '" data-pick="' + kind + '" data-id="' + esc(id) + '" data-v="' + v + '">' + v + "</button>").join("");
}
function head(i) {
  const p = i.proposal;
  const cur = i.task.priority || "no priority";
  return '<div class="meta"><span>' + esc(cur) + " → <b>" + p.priority + "</b></span><span>" + p.class +
    "</span><span>" + p.outcome + "</span><span>" + esc(i.task.createdBy) + "</span><span>" + age(i.task.createdAt) +
    "</span><span>" + esc(i.taskId) + "</span></div>" +
    '<div class="title">' + esc(i.task.title) + "</div>";
}
function body(i) {
  const p = i.proposal;
  let h = '<div class="why"><span class="label">Why</span><br>' + esc(p.why) + "</div>";
  if (p.outcome === "rescope" || p.title || p.scope) {
    h += '<div class="rescope"><span class="label">Proposed scope</span>';
    if (p.title) h += '<div class="title">' + esc(p.title) + "</div>";
    if (p.scope) h += '<div class="desc">' + esc(p.scope) + "</div>";
    h += "</div>";
  }
  if (i.task.description) h += "<details><summary>Current description</summary><div class=\\"desc\\">" + esc(i.task.description) + "</div></details>";
  return h;
}
function openCard(i) {
  const p = i.proposal;
  const k = picks[i.taskId] || (picks[i.taskId] = { priority: p.priority, class: p.class, outcome: p.outcome, note: "" });
  return '<div class="card">' + head(i) + body(i) +
    '<div class="row"><span class="label">Priority</span>' + chips("priority", PRIORITIES, k.priority, p.priority, i.taskId) + "</div>" +
    '<div class="row"><span class="label">Class</span>' + chips("class", CLASSES, k.class, p.class, i.taskId) + "</div>" +
    '<div class="row"><span class="label">Outcome</span>' + chips("outcome", OUTCOMES, k.outcome, p.outcome, i.taskId) + "</div>" +
    '<textarea rows="1" placeholder="Note for the curator (optional)" data-note="' + esc(i.taskId) + '">' + esc(k.note) + "</textarea>" +
    '<div class="err" data-err="' + esc(i.taskId) + '"></div>' +
    '<div class="actions"><button class="btn primary" data-decide="' + esc(i.taskId) + '">Confirm</button>' +
    '<button class="btn ghost" data-later="' + esc(i.taskId) + '">Later</button></div></div>';
}
function decidedCard(i) {
  const d = i.decision;
  const s = state(i);
  let status = s === "applied" ? '<span class="ok">On the board</span>'
    : s === "failed" ? '<span class="warn">Failed: ' + esc(i.applied.error || "no reason given") + "</span>"
    : "Waiting for the curator";
  let h = '<div class="card">' + head(i) +
    '<div class="why"><span class="label">Your decision</span><br><b>' + d.priority + " · " + d.class + " · " + d.outcome + "</b>" +
    (d.note ? "<br>" + esc(d.note) : "") + "</div>" +
    '<div class="meta">' + status + "</div>";
  if (s !== "applied") h += '<div class="err" data-err="' + esc(i.taskId) + '"></div><div class="actions"><button class="btn ghost" data-undo="' + esc(i.taskId) + '">Undo</button></div>';
  return h + "</div>";
}
function render() {
  renderTabs();
  let shown = items.filter(inTab);
  if (tab === "open") shown = shown.filter(i => !later.has(i.taskId)).concat(shown.filter(i => later.has(i.taskId)));
  if (tab === "applied") shown.sort((a, b) => b.applied.at - a.applied.at);
  const el = document.getElementById("list");
  el.innerHTML = shown.length ? shown.map(i => tab === "open" ? openCard(i) : decidedCard(i)).join("")
    : '<div class="empty">' + (tab === "open" ? "Nothing to review." : "Nothing here.") + "</div>";
}
function showErr(id, msg) {
  const el = document.querySelector('[data-err="' + CSS.escape(id) + '"]');
  if (el) el.textContent = msg;
}
document.addEventListener("click", async e => {
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { tab = d.tab; render(); window.scrollTo(0, 0); return; }
  if (d.pick) { picks[d.id][d.pick] = d.v; render(); return; }
  if (d.later) { later.add(d.later); render(); return; }
  if (d.decide) {
    const k = picks[d.decide];
    if (k.outcome === "rescope") {
      const i = items.find(x => x.taskId === d.decide);
      if (!i.proposal.title && !i.proposal.scope && !k.note.trim()) return showErr(d.decide, "A rescope needs a note with the new scope.");
    }
    try { t.disabled = true; await api("/api/items/" + encodeURIComponent(d.decide) + "/decide", { method: "POST", body: k }); later.delete(d.decide); await load(); }
    catch (err) { t.disabled = false; showErr(d.decide, err.message); }
    return;
  }
  if (d.undo) {
    try { await api("/api/items/" + encodeURIComponent(d.undo) + "/undo", { method: "POST" }); await load(); }
    catch (err) { showErr(d.undo, err.message); }
  }
});
document.addEventListener("input", e => {
  const id = e.target.dataset && e.target.dataset.note;
  if (id !== undefined && picks[id]) picks[id].note = e.target.value;
});
load();
setInterval(() => { if (!document.activeElement || document.activeElement.tagName !== "TEXTAREA") load(); }, 60000);
</script>
</body>
</html>`;
