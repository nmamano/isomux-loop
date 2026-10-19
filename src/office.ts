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

export type PatchResult = { ok: true; task: Task } | { ok: false; status: number };

export interface Office {
  // Open and in-progress tasks of the loop's room (the board's default listing).
  tasks(): Promise<Task[]>;
  task(id: string): Promise<Task>;
  createTask(body: { title: string; description: string; priority: string; roomId: string }): Promise<Task>;
  // Every task of the room, done, obsolete and P4 included.
  allTasks(): Promise<Task[]>;
  // When the task last moved to done or obsolete, from its history; null if unknown.
  closedAt(id: string): Promise<number | null>;
  agents(): Promise<Agent[]>;
  patchTask(id: string, body: Record<string, unknown>): Promise<PatchResult>;
  // Without a target the message goes to the app's configured target.
  message(text: string, targetAgentId?: string): Promise<boolean>;
}

export function httpOffice(token: string, base = OFFICE): Office {
  const auth = { Authorization: `Bearer ${token}` };
  async function getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers: auth });
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]} answered ${res.status}`);
    return (await res.json()) as T;
  }
  return {
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
      if (!res.ok) return { ok: false, status: res.status };
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
  };
}
