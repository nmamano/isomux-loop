// The office API as the app token reaches it. Since task c0204eb6 the app
// token has the reach of the agent that owns the app (Isomux Curator): the
// task board, the agent list, and a message to any live agent in its room.

import { OFFICE, ROOM_ID } from "./config";

export type Task = {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: string | null;
  assignee?: string | null;
  // Since isomux task 83f71be9: the id of the live agent the assignee named
  // when it was set; absent for members and older rows.
  assigneeAgentId?: string;
  createdAt: number;
  roomId?: string;
  version: string;
};

export type Agent = {
  id: string;
  name: string;
  roomId?: string;
  inFlightTurn: unknown | null;
  pendingPrompt?: unknown | null;
};

// killed: a 409 because the task's holder is a killed agent (task_held).
export type PatchResult = { ok: true; task: Task } | { ok: false; status: number; killed?: boolean };

export interface Office {
  // Open and in-progress tasks of the loop's room (the board's default listing).
  tasks(): Promise<Task[]>;
  task(id: string): Promise<Task>;
  createTask(body: { title: string; description: string; priority: string; roomId: string }): Promise<Task>;
  // Every task of the room, done, obsolete and P4 included.
  allTasks(): Promise<Task[]>;
  // When the task last moved to done or obsolete, from its history; null if unknown.
  closedAt(id: string): Promise<number | null>;
  // When the description last changed, from its history; null if none is on record.
  lastEdited(id: string): Promise<number | null>;
  // The last assignee from names that the history records, with its agent id; null if none.
  lastAssignee(id: string, names: string[]): Promise<{ name: string; agentId?: string } | null>;
  agents(): Promise<Agent[]>;
  patchTask(id: string, body: Record<string, unknown>): Promise<PatchResult>;
  // Without a target the message goes to the app's configured target.
  message(text: string, targetAgentId?: string): Promise<boolean>;
  // Clears the agent's conversation (POST /api/agents/:id/new-conversation;
  // the app has the reach of its privileged owner, Isomux Curator). The
  // server clears even an agent in a turn, so the caller checks it is idle.
  // status: the HTTP status, 0 when the request failed.
  newConversation(agentId: string): Promise<{ ok: boolean; status: number }>;
  // The agent's provider usage windows (GET /api/agents/:id/subscription);
  // agents on one account share them. The app token reaches it with its
  // owner's reach (read live 2026-11-06).
  subscription?(agentId: string): Promise<UsageReading>;
  // The agent's open asks, oldest first, with the members each is for. The
  // app reads the agent's ask log (log:read, from its owner) and confirms
  // each ask the log shows open, since an older ask can lack its events.
  openAsks?(agentId: string): Promise<{ id: string; members: string[] }[]>;
}

export type UsageReading =
  | { available: true; windows: { label: string; usedPercent: number; resetsAtMs: number | null }[] }
  | { available: false; reason?: string };

export function httpOffice(token: string, base = OFFICE): Office {
  const auth = { Authorization: `Bearer ${token}` };
  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: auth });
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} answered ${res.status}`);
    return (await res.json()) as T;
  }
  // A closed ask stays closed: it is not read again.
  const closedAsks = new Set<string>();
  return {
    async openAsks(agentId) {
      type Event = { askId: string; kind: string; at: number };
      const created: string[] = [];
      const ended = new Set<string>();
      let before: number | null = null;
      for (let page = 0; page < 20; page++) {
        const q: string = `/api/agents/${encodeURIComponent(agentId)}/asks/events?limit=200${before === null ? "" : `&before=${before}`}`;
        const r = await getJson<{ events: Event[]; nextBefore: number | null }>(q);
        for (const e of r.events) {
          if (e.kind === "closed") ended.add(e.askId);
          else if (e.kind === "created" && !ended.has(e.askId) && !closedAsks.has(e.askId)) created.push(e.askId);
        }
        if (r.nextBefore === null || r.nextBefore === undefined) break;
        before = r.nextBefore;
      }
      const out: { id: string; members: string[]; createdAt: number }[] = [];
      for (const id of created) {
        const a = await getJson<{ id: string; members?: string[]; member?: string; closed?: unknown; createdAt: number }>(`/api/asks/${encodeURIComponent(id)}`);
        if (a.closed) closedAsks.add(id);
        else out.push({ id, members: a.members ?? (a.member ? [a.member] : []), createdAt: a.createdAt });
      }
      return out.sort((a, b) => a.createdAt - b.createdAt).map(({ id, members }) => ({ id, members }));
    },
    tasks: () => getJson<Task[]>(`/api/tasks?roomId=${ROOM_ID}`),
    task: (id) => getJson<Task>(`/api/tasks/${encodeURIComponent(id)}`),
    async createTask(body) {
      const res = await fetch(`${base}/api/tasks`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST /api/tasks answered ${res.status}`);
      return (await res.json()) as Task;
    },
    allTasks: () => getJson<Task[]>(`/api/tasks?roomId=${ROOM_ID}&status=all`),
    async closedAt(id) {
      type Item = { time: number; taskChanges?: { status?: { new?: string } } };
      const h = await getJson<{ items: Item[] }>(`/api/tasks/${encodeURIComponent(id)}/history`);
      const times = h.items
        .filter((i) => ["done", "obsolete"].includes(i.taskChanges?.status?.new ?? ""))
        .map((i) => i.time);
      return times.length > 0 ? Math.max(...times) : null;
    },
    async lastEdited(id) {
      type Item = { time: number; fields?: string[] };
      const h = await getJson<{ items: Item[] }>(`/api/tasks/${encodeURIComponent(id)}/history`);
      const times = h.items.filter((i) => i.fields?.includes("description")).map((i) => i.time);
      return times.length > 0 ? Math.max(...times) : null;
    },
    async lastAssignee(id, names) {
      type Change = { new?: string | null };
      type Item = { time: number; taskChanges?: { assignee?: Change; assigneeAgentId?: Change } };
      const h = await getJson<{ items: Item[] }>(`/api/tasks/${encodeURIComponent(id)}/history`);
      const hit = h.items
        .filter((i) => names.includes(i.taskChanges?.assignee?.new ?? ""))
        .sort((a, b) => b.time - a.time)[0];
      if (!hit) return null;
      const agentId = hit.taskChanges?.assigneeAgentId?.new;
      return { name: hit.taskChanges!.assignee!.new!, ...(agentId ? { agentId } : {}) };
    },
    async agents() {
      const list = await getJson<Agent[] | { agents: Agent[] }>("/agents?back=1");
      return Array.isArray(list) ? list : list.agents;
    },
    async patchTask(id, body) {
      const res = await fetch(`${base}/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = res.status === 409 ? ((await res.json().catch(() => null)) as { error?: { killed?: unknown } } | null) : null;
        return { ok: false, status: res.status, ...(err?.error?.killed === true ? { killed: true } : {}) };
      }
      return { ok: true, task: (await res.json()) as Task };
    },
    async message(text, targetAgentId) {
      try {
        const res = await fetch(`${base}/api/app/message`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(targetAgentId ? { text, targetAgentId } : { text }),
        });
        if (!res.ok) console.error(`message_rejected status=${res.status}`);
        return res.ok;
      } catch (err) {
        console.error(`message_failed ${String(err)}`);
        return false;
      }
    },
    subscription: (agentId) => getJson<UsageReading>(`/api/agents/${encodeURIComponent(agentId)}/subscription`),
    async newConversation(agentId) {
      try {
        const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/new-conversation`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        });
        return { ok: res.ok, status: res.status };
      } catch (err) {
        console.error(`new_conversation_failed ${String(err)}`);
        return { ok: false, status: 0 };
      }
    },
  };
}
