export type SessionLike = {
  id: string;
  cost?: number;
  agent?: string;
  parentID?: string;
  title?: string;
  time?: {
    updated?: number;
  };
  model?: {
    providerID?: string;
    id?: string;
  };
};

export type MessageLike = {
  role?: string;
  cost?: number;
  providerID?: string;
  modelID?: string;
};

/**
 * The subset of an OpenCode durable session event needed to attribute cost.
 *
 * `session.next.step.started` carries the model that produced a step,
 * `session.next.step.ended` carries its cost. Both are keyed by the assistant
 * message id, and both survive compaction and revert because they live in the
 * durable event log rather than in the (prunable) projected messages.
 */
export type DurableEventLike = {
  type?: string;
  durable?: {
    seq?: number;
  };
  data?: {
    timestamp?: number;
    sessionID?: string;
    assistantMessageID?: string;
    cost?: number;
    model?: {
      id?: string;
      providerID?: string;
    };
  };
};

export type CostDeps = {
  getSession: (sessionID: string) => SessionLike | undefined;
  getChildren: (sessionID: string) => Promise<readonly SessionLike[]>;
  getMessages: (sessionID: string) => readonly MessageLike[] | Promise<readonly MessageLike[]>;
  getEvents?: (sessionID: string) => Promise<readonly DurableEventLike[]>;
};

export type SessionCosts = {
  parent: number;
  task: number;
  subagent: number;
};

export type CostBreakdown = {
  sessions: SessionCosts;
  models: Record<string, number>;
  total: number;
};

export type CollectCostsOptions = {
  /**
   * When false the per-model breakdown is skipped entirely. The session totals
   * come from `session.cost` alone, so a live indicator can read the total
   * without paying for event/message history.
   */
  models?: boolean;
};

export type SessionGroupSession = {
  id: string;
  title: string;
  total: number;
  selection: number;
};

export type SessionGroup = {
  label: string;
  total: number;
  sessions: SessionGroupSession[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Agents that OpenCode spawns through the Task tool. Their sessions are
 * reported under the "Task" category in the breakdown.
 */
export const TASK_AGENTS: ReadonlySet<string> = new Set(["explore", "general"]);

const EPSILON = 0.0001;

const STEP_STARTED = "session.next.step.started";
const STEP_ENDED = "session.next.step.ended";
const UNKNOWN_MODEL = "unknown/unknown";

const modelKey = (providerID: string | undefined, modelID: string | undefined): string =>
  `${providerID ?? "unknown"}/${modelID ?? "unknown"}`;

const sumCosts = (models: Record<string, number>): number =>
  Object.values(models).reduce((total, cost) => total + cost, 0);

/**
 * Attributes each `session.next.step.ended` cost to the model of the matching
 * `session.next.step.started`. Steps are matched per assistant message id with a
 * queue, so several steps of the same message keep their own model.
 */
const costsFromEvents = (events: readonly DurableEventLike[]): Record<string, number> => {
  const models: Record<string, number> = {};
  const pending = new Map<string, string[]>();

  for (const event of events) {
    if (event.type === STEP_STARTED) {
      const messageID = event.data?.assistantMessageID;
      const model = event.data?.model;
      if (!messageID || !model) continue;
      const key = modelKey(model.providerID, model.id);
      const queue = pending.get(messageID);
      if (queue) {
        queue.push(key);
      } else {
        pending.set(messageID, [key]);
      }
      continue;
    }

    if (event.type !== STEP_ENDED) continue;
    const cost = event.data?.cost;
    if (typeof cost !== "number" || cost <= 0) continue;

    const messageID = event.data?.assistantMessageID;
    const queue = messageID ? pending.get(messageID) : undefined;
    const key = queue && queue.length > 0 ? queue.shift()! : UNKNOWN_MODEL;
    models[key] = (models[key] ?? 0) + cost;
  }

  return models;
};

const costsFromMessages = (
  messages: readonly MessageLike[],
  session: SessionLike | undefined
): Record<string, number> => {
  const models: Record<string, number> = {};

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const cost = message.cost;
    if (typeof cost !== "number" || cost <= 0) continue;

    const key = modelKey(
      message.providerID ?? session?.model?.providerID,
      message.modelID ?? session?.model?.id
    );
    models[key] = (models[key] ?? 0) + cost;
  }

  return models;
};

/**
 * Spreads a remainder over the models already observed, proportionally to their
 * attributed cost. This keeps the model rows summing to the real session total
 * without dumping hidden spend onto whichever model is currently selected.
 */
const applyRemainder = (
  models: Record<string, number>,
  remainder: number,
  session: SessionLike | undefined
): void => {
  const entries = Object.entries(models).filter(([, cost]) => cost > 0);
  const attributed = entries.reduce((total, [, cost]) => total + cost, 0);

  if (attributed > 0) {
    for (const [key, cost] of entries) {
      models[key] = cost + remainder * (cost / attributed);
    }
    return;
  }

  const key = modelKey(session?.model?.providerID, session?.model?.id);
  models[key] = (models[key] ?? 0) + remainder;
};

export async function collectCosts(
  rootSessionID: string,
  deps: CostDeps,
  options: CollectCostsOptions = {}
): Promise<CostBreakdown> {
  const includeModels = options.models !== false;
  const sessions: SessionCosts = { parent: 0, task: 0, subagent: 0 };
  const models: Record<string, number> = {};
  const visited = new Set<string>();

  const walk = async (sessionID: string, fallback?: SessionLike): Promise<void> => {
    if (visited.has(sessionID)) return;
    visited.add(sessionID);

    const session = deps.getSession(sessionID) ?? fallback;
    const sessionCost = session && typeof session.cost === "number" ? session.cost : 0;

    if (sessionID === rootSessionID) {
      sessions.parent += sessionCost;
    } else if (session?.agent && TASK_AGENTS.has(session.agent)) {
      sessions.task += sessionCost;
    } else {
      sessions.subagent += sessionCost;
    }

    if (includeModels) {
      let attributed: Record<string, number> | undefined;

      if (deps.getEvents) {
        const events = await deps.getEvents(sessionID);
        const fromEvents = costsFromEvents(events);
        if (sumCosts(fromEvents) > 0) attributed = fromEvents;
      }

      if (!attributed) {
        attributed = costsFromMessages(await deps.getMessages(sessionID), session);
      }

      const remainder = sessionCost - sumCosts(attributed);
      if (remainder > EPSILON) {
        applyRemainder(attributed, remainder, session);
      }

      for (const [key, cost] of Object.entries(attributed)) {
        models[key] = (models[key] ?? 0) + cost;
      }
    }

    for (const child of await deps.getChildren(sessionID)) {
      await walk(child.id, child);
    }
  };

  await walk(rootSessionID);

  const total = sessions.parent + sessions.task + sessions.subagent;
  return { sessions, models, total };
}

/**
 * Totals every session's cost including all of its descendants.
 *
 * Sessions without a `parentID` (or whose parent is not part of the provided
 * list) are treated as roots. The returned map contains an entry for every
 * input session, keyed by session id.
 */
export function computeSessionTreeTotals(
  sessions: readonly SessionLike[]
): Map<string, number> {
  const byID = new Map<string, SessionLike>();
  for (const session of sessions) {
    byID.set(session.id, session);
  }

  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID || !byID.has(session.parentID)) continue;
    const list = children.get(session.parentID);
    if (list) {
      list.push(session.id);
    } else {
      children.set(session.parentID, [session.id]);
    }
  }

  const totals = new Map<string, number>();
  const visiting = new Set<string>();

  const sum = (id: string): number => {
    const cached = totals.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;

    visiting.add(id);
    let total = byID.get(id)?.cost ?? 0;
    for (const childID of children.get(id) ?? []) {
      total += sum(childID);
    }
    visiting.delete(id);

    totals.set(id, total);
    return total;
  };

  for (const session of sessions) {
    sum(session.id);
  }

  return totals;
}

/**
 * Groups the root sessions updated within the last `days` days by calendar day.
 *
 * Sessions are ordered by most recently updated first and days keep that order.
 * Each group carries the recursive total of all its sessions, while every
 * session carries its own recursive total and its position in the flat
 * selection order.
 */
export function groupSessionsByDay(
  sessions: readonly SessionLike[],
  now: number,
  days: number
): SessionGroup[] {
  const totals = computeSessionTreeTotals(sessions);
  const cutoff = now - days * MS_PER_DAY;
  const today = new Date(now).toDateString();

  const roots = sessions
    .filter((session) => !session.parentID)
    .filter((session) => (session.time?.updated ?? 0) >= cutoff)
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

  const groups = new Map<string, SessionGroup>();
  let selection = 0;

  for (const session of roots) {
    const updated = session.time?.updated ?? now;
    const key = new Date(updated).toDateString();
    const label = key === today ? "Today" : key;

    let group = groups.get(key);
    if (!group) {
      group = { label, total: 0, sessions: [] };
      groups.set(key, group);
    }

    const total = totals.get(session.id) ?? 0;
    group.total += total;
    group.sessions.push({
      id: session.id,
      title: session.title ?? "Untitled",
      total,
      selection
    });
    selection += 1;
  }

  return [...groups.values()];
}

export function formatSessionSection(sessions: SessionCosts): string {
  const total = sessions.parent + sessions.task + sessions.subagent;
  return [
    "By session",
    `Session:   $${sessions.parent.toFixed(2)}`,
    `Task:      $${sessions.task.toFixed(2)}`,
    `Sub-agent: $${sessions.subagent.toFixed(2)}`,
    "---------------",
    `Total:     $${total.toFixed(2)}`,
  ].join("\n");
}

export function formatModelSection(models: Record<string, number>, total: number): string {
  const sorted = Object.entries(models).sort((a, b) => b[1] - a[1]);

  let labelWidth = "Total:".length;
  for (const [key] of sorted) {
    labelWidth = Math.max(labelWidth, key.length + 1);
  }

  const lines = sorted.map(
    ([key, cost]) => `${`${key}:`.padEnd(labelWidth + 1, " ")}$${cost.toFixed(2)}`
  );
  const separator = "-".repeat(labelWidth + 7);
  const totalLine = `${"Total:".padEnd(labelWidth + 1, " ")}$${total.toFixed(2)}`;

  return ["By provider/model", ...lines, separator, totalLine].join("\n");
}

export function formatBreakdown(breakdown: CostBreakdown): string {
  return `${formatSessionSection(breakdown.sessions)}\n\n${formatModelSection(
    breakdown.models,
    breakdown.total
  )}`;
}
