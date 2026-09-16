export type SessionLike = {
  id: string;
  cost?: number;
  agent?: string;
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

export type CostDeps = {
  getSession: (sessionID: string) => SessionLike | undefined;
  getChildren: (sessionID: string) => Promise<readonly SessionLike[]>;
  getMessages: (sessionID: string) => readonly MessageLike[];
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

/**
 * Agents that OpenCode spawns through the Task tool. Their sessions are
 * reported under the "Task" category in the breakdown.
 */
export const TASK_AGENTS: ReadonlySet<string> = new Set(["explore", "general"]);

const EPSILON = 0.0001;

export async function collectCosts(rootSessionID: string, deps: CostDeps): Promise<CostBreakdown> {
  const sessions: SessionCosts = { parent: 0, task: 0, subagent: 0 };
  const models: Record<string, number> = {};
  const visited = new Set<string>();

  const addModelCost = (providerID: string, modelID: string, cost: number) => {
    const key = `${providerID}/${modelID}`;
    models[key] = (models[key] ?? 0) + cost;
  };

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

    let attributedCost = 0;
    for (const message of deps.getMessages(sessionID)) {
      if (message.role !== "assistant") continue;
      const cost = message.cost;
      if (typeof cost !== "number" || cost <= 0) continue;
      addModelCost(
        message.providerID ?? session?.model?.providerID ?? "unknown",
        message.modelID ?? session?.model?.id ?? "unknown",
        cost
      );
      attributedCost += cost;
    }

    const remainder = sessionCost - attributedCost;
    if (remainder > EPSILON) {
      addModelCost(
        session?.model?.providerID ?? "unknown",
        session?.model?.id ?? "unknown",
        remainder
      );
    }

    for (const child of await deps.getChildren(sessionID)) {
      await walk(child.id, child);
    }
  };

  await walk(rootSessionID);

  const total = sessions.parent + sessions.task + sessions.subagent;
  return { sessions, models, total };
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