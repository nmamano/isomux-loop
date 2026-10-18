// The loop app's page: status, triage and copy sign-off. Plain JS, no build.
const PRIORITIES = ["P0", "P1", "P2", "P3", "P4"];
const CLASSES = ["auto", "decide", "taste", "authority"];
const OUTCOMES = ["keep", "rescope", "obsolete"];
const TABS = [
  ["status", "Status"],
  ["open", "To review"],
  ["decided", "Decided"],
  ["applied", "Applied"],
  ["copy", "Copy"],
];
let tab = "status";
let copyId = null;
let items = [];
let counts = {};
let loopState = null;
let copies = [];
const later = new Set();
const picks = {};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function age(ms) {
  if (!ms) return "";
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d < 1 ? "today" : d + " d old";
}
function clock(ms) {
  if (!ms) return "never";
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 120 ? m + " min ago" : Math.round(m / 60) + " h ago";
}
async function api(path, opts) {
  const res = await fetch(
    path,
    opts && { method: opts.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body ?? {}) },
  );
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

// --- routing -------------------------------------------------------------------

function readLocation() {
  const m = location.pathname.match(/^\/copy\/([^/]+)/);
  if (m) {
    tab = "copy";
    copyId = decodeURIComponent(m[1]);
  } else if (location.pathname === "/") {
    copyId = null;
  }
}
function go(nextTab, nextCopyId) {
  tab = nextTab;
  copyId = nextCopyId ?? null;
  const path = copyId ? "/copy/" + encodeURIComponent(copyId) : "/";
  if (location.pathname !== path) history.pushState(null, "", path);
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  readLocation();
  render();
});

async function load() {
  const [c, i, s, cp] = await Promise.allSettled([
    api("/api/summary"),
    api("/api/items?state=all"),
    api("/api/status"),
    api("/api/copy"),
  ]);
  if (c.status === "fulfilled") counts = c.value;
  if (i.status === "fulfilled") items = i.value;
  if (s.status === "fulfilled") loopState = s.value;
  if (cp.status === "fulfilled") copies = cp.value;
  render();
}

// --- shared -----------------------------------------------------------------

function itemState(i) {
  if (!i.decision) return "open";
  if (i.applied && i.applied.decidedAt === i.decision.decidedAt) return i.applied.ok ? "applied" : "failed";
  return "decided";
}
function renderTabs() {
  const n = {
    open: counts.open || 0,
    decided: (counts.decided || 0) + (counts.failed || 0),
    applied: counts.applied || 0,
    copy: copies.length,
  };
  document.getElementById("tabs").innerHTML = TABS.map(
    ([k, label]) =>
      '<button class="' + (k === tab ? "on" : "") + '" data-tab="' + k + '">' + label + (k in n ? " (" + n[k] + ")" : "") + "</button>",
  ).join("");
}
function taskLine(t, who) {
  const m = t.title.match(/^\[\s*([a-z]+)\s*\|\s*([^\]]*?)\s*\]\s*(.*)$/s);
  const tag = m ? '<span class="tag">' + esc(m[1]) + " · " + esc(m[2]) + "</span>" : "";
  return (
    '<div class="line">' +
    (who ? '<span class="who">' + esc(who) + "</span> · " : "") +
    '<span class="tag">' + esc(t.priority || "-") + "</span>" + tag + esc(m ? m[3] : t.title) +
    ' <span class="small">' + esc(t.id) + "</span></div>"
  );
}
function section(title, lines, empty) {
  return "<h2>" + title + "</h2>" + (lines.length ? lines.join("") : '<div class="small">' + empty + "</div>");
}

// --- status -----------------------------------------------------------------

function renderStatus() {
  const s = loopState;
  if (!s) return '<div class="empty">Loading.</div>';
  let h =
    '<div class="banner ' + (s.paused ? "paused" : "run") + '"><div><b>' +
    (s.paused ? "Paused: no dispatch, no tick" : "Running: dispatch and tick") + "</b>" +
    (s.paused && s.pausedSince ? '<div class="small">since ' + clock(s.pausedSince) + "</div>" : "") +
    '</div><button class="btn ghost" data-pause="' + (s.paused ? "resume" : "pause") + '">' +
    (s.paused ? "Resume" : "Pause") + "</button></div>";
  const d = s.lastDispatch;
  const t = s.lastTick;
  h += '<div class="small">Last dispatch: ' + (d ? clock(d.at) : "not yet");
  if (d && d.error) h += ' · <span class="warn">' + esc(d.error) + "</span>";
  else if (d && d.result) h += " · " + d.result.assigned.length + " assigned" + (d.result.errors.length ? ' · <span class="warn">' + esc(d.result.errors.join("; ")) + "</span>" : "");
  h += "<br>Last tick: " + (t ? clock(t.at) : "not yet");
  if (t && t.error) h += ' · <span class="warn">' + esc(t.error) + "</span>";
  h += "</div>";
  if (s.error) return h + '<div class="err">Board unreadable: ' + esc(s.error) + "</div>";
  const b = s.board;
  h += section("Working", b.holding.map((x) => taskLine(x.task, x.worker)), "No worker holds a task.");
  h += '<div class="small" style="margin-top:6px">Free: ' + (b.freeWorkers.length ? esc(b.freeWorkers.join(", ")) : "none") + "</div>";
  h += section("Ready queue (" + b.ready.length + ")", b.ready.map((x) => taskLine(x)), "Nothing is ready.");
  h += section("Waiting to merge (" + b.merging.length + ")", b.merging.map((x) => taskLine(x)), "Nothing waits to merge.");
  h += section("Parked for Nil (" + b.parked.length + ")", b.parked.map((x) => taskLine(x)), "Nothing is parked.");
  return h;
}

// --- triage -----------------------------------------------------------------

function chips(kind, list, chosen, proposed, id) {
  return list
    .map(
      (v) =>
        '<button class="chip' + (v === chosen ? " on" : "") + (v === proposed ? " proposed" : "") +
        '" data-pick="' + kind + '" data-id="' + esc(id) + '" data-v="' + v + '">' + v + "</button>",
    )
    .join("");
}
function head(i) {
  const p = i.proposal;
  return (
    '<div class="meta"><span>' + esc(i.task.priority || "no priority") + " → <b>" + p.priority + "</b></span><span>" +
    p.class + "</span><span>" + p.outcome + "</span><span>" + esc(i.task.createdBy) + "</span><span>" +
    age(i.task.createdAt) + "</span><span>" + esc(i.taskId) + "</span></div>" +
    '<div class="title">' + esc(i.task.title) + "</div>"
  );
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
  if (i.task.description)
    h += '<details><summary>Current description</summary><div class="desc">' + esc(i.task.description) + "</div></details>";
  return h;
}
function openCard(i) {
  const p = i.proposal;
  const k = picks[i.taskId] || (picks[i.taskId] = { priority: p.priority, class: p.class, outcome: p.outcome, note: "" });
  return (
    '<div class="card">' + head(i) + body(i) +
    '<div class="row"><span class="label">Priority</span>' + chips("priority", PRIORITIES, k.priority, p.priority, i.taskId) + "</div>" +
    '<div class="row"><span class="label">Class</span>' + chips("class", CLASSES, k.class, p.class, i.taskId) + "</div>" +
    '<div class="row"><span class="label">Outcome</span>' + chips("outcome", OUTCOMES, k.outcome, p.outcome, i.taskId) + "</div>" +
    '<textarea rows="1" placeholder="Note for the curator (optional)" data-note="' + esc(i.taskId) + '">' + esc(k.note) + "</textarea>" +
    '<div class="err" data-err="' + esc(i.taskId) + '"></div>' +
    '<div class="actions"><button class="btn primary" data-decide="' + esc(i.taskId) + '">Confirm</button>' +
    '<button class="btn ghost" data-later="' + esc(i.taskId) + '">Later</button></div></div>'
  );
}
function decidedCard(i) {
  const d = i.decision;
  const s = itemState(i);
  const status =
    s === "applied" ? '<span class="ok">On the board</span>'
    : s === "failed" ? '<span class="warn">Failed: ' + esc(i.applied.error || "no reason given") + "</span>"
    : "Waiting for the curator";
  let h =
    '<div class="card">' + head(i) +
    '<div class="why"><span class="label">Your decision</span><br><b>' + d.priority + " · " + d.class + " · " + d.outcome + "</b>" +
    (d.note ? "<br>" + esc(d.note) : "") + "</div>" + '<div class="meta">' + status + "</div>";
  if (s !== "applied")
    h += '<div class="err" data-err="' + esc(i.taskId) + '"></div><div class="actions"><button class="btn ghost" data-undo="' + esc(i.taskId) + '">Undo</button></div>';
  return h + "</div>";
}
function renderTriage() {
  let shown = items.filter((i) => {
    const s = itemState(i);
    return tab === "decided" ? s === "decided" || s === "failed" : s === tab;
  });
  if (tab === "open") shown = shown.filter((i) => !later.has(i.taskId)).concat(shown.filter((i) => later.has(i.taskId)));
  if (tab === "applied") shown.sort((a, b) => b.applied.at - a.applied.at);
  if (!shown.length) return '<div class="empty">' + (tab === "open" ? "Nothing to review." : "Nothing here.") + "</div>";
  return shown.map((i) => (tab === "open" ? openCard(i) : decidedCard(i))).join("");
}

// --- copy -------------------------------------------------------------------

// Word-level diff (LCS). Too long a pair is shown without marks.
function diff(a, b) {
  const x = a.split(/(\s+)/);
  const y = b.split(/(\s+)/);
  if (x.length * y.length > 4_000_000) return [esc(a), esc(b)];
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0;
  let j = 0;
  let oldH = "";
  let newH = "";
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      oldH += esc(x[i]);
      newH += esc(y[j]);
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) {
      newH += /^\s+$/.test(y[j]) ? esc(y[j]) : "<ins>" + esc(y[j]) + "</ins>";
      j++;
    } else {
      oldH += /^\s+$/.test(x[i]) ? esc(x[i]) : "<del>" + esc(x[i]) + "</del>";
      i++;
    }
  }
  return [oldH, newH];
}
function renderCopy() {
  if (copyId) {
    const c = copies.find((x) => x.taskId === copyId);
    if (!c) return '<p><a href="/" data-copy-list="1">All copy</a></p><div class="empty">No copy waits for this task.</div>';
    const [o, n] = diff(c.old || "", c.new);
    return (
      '<p><a href="/" data-copy-list="1">All copy</a></p><div class="title">' + esc(c.title) + "</div>" +
      '<div class="small">' + esc(c.taskId) + " · updated " + clock(c.updatedAt) + "</div>" +
      '<div class="cols"><div><h2>Old</h2><div class="copytext">' + (c.old ? o : '<span class="small">New copy</span>') +
      '</div></div><div><h2>New</h2><div class="copytext">' + n + "</div></div></div>"
    );
  }
  if (!copies.length) return '<div class="empty">No copy waits for sign-off.</div>';
  return copies
    .map(
      (c) =>
        '<div class="line"><a href="/copy/' + encodeURIComponent(c.taskId) + '" data-copy="' + esc(c.taskId) + '">' +
        esc(c.title) + '</a> <span class="small">' + esc(c.taskId) + " · " + clock(c.updatedAt) + "</span></div>",
    )
    .join("");
}

// --- render and events ----------------------------------------------------------

function render() {
  renderTabs();
  const el = document.getElementById("list");
  el.innerHTML = tab === "status" ? renderStatus() : tab === "copy" ? renderCopy() : renderTriage();
}
function showErr(id, msg) {
  const el = document.querySelector('[data-err="' + CSS.escape(id) + '"]');
  if (el) el.textContent = msg;
}
document.addEventListener("click", async (e) => {
  const a = e.target.closest("a[data-copy], a[data-copy-list]");
  if (a) {
    e.preventDefault();
    go("copy", a.dataset.copy || null);
    return;
  }
  const t = e.target.closest("button");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) return go(d.tab);
  if (d.pick) {
    picks[d.id][d.pick] = d.v;
    return render();
  }
  if (d.later) {
    later.add(d.later);
    return render();
  }
  if (d.pause) {
    try {
      t.disabled = true;
      await api("/api/" + d.pause, { method: "POST" });
    } finally {
      await load();
    }
    return;
  }
  if (d.decide) {
    const k = picks[d.decide];
    if (k.outcome === "rescope") {
      const i = items.find((x) => x.taskId === d.decide);
      if (!i.proposal.title && !i.proposal.scope && !k.note.trim()) return showErr(d.decide, "A rescope needs a note with the new scope.");
    }
    try {
      t.disabled = true;
      await api("/api/items/" + encodeURIComponent(d.decide) + "/decide", { method: "POST", body: k });
      later.delete(d.decide);
      await load();
    } catch (err) {
      t.disabled = false;
      showErr(d.decide, err.message);
    }
    return;
  }
  if (d.undo) {
    try {
      await api("/api/items/" + encodeURIComponent(d.undo) + "/undo", { method: "POST" });
      await load();
    } catch (err) {
      showErr(d.undo, err.message);
    }
  }
});
document.addEventListener("input", (e) => {
  const id = e.target.dataset && e.target.dataset.note;
  if (id !== undefined && picks[id]) picks[id].note = e.target.value;
});
readLocation();
// Open on triage while proposals wait for Nil, else on the status.
load().then(() => {
  if (!copyId && tab === "status" && counts.open > 0) {
    tab = "open";
    render();
  }
});
setInterval(() => {
  if (!document.activeElement || document.activeElement.tagName !== "TEXTAREA") load();
}, 60000);
