import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectCosts,
  computeSessionTreeTotals,
  formatBreakdown,
  formatModelSection,
  formatSessionSection,
  groupSessionsByDay,
  type CostDeps,
  type DurableEventLike,
  type MessageLike,
  type SessionLike
} from "./cost.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type DepsOptions = {
  sessions: Record<string, SessionLike>;
  children?: Record<string, string[]>;
  messages?: Record<string, MessageLike[]>;
  events?: Record<string, DurableEventLike[]>;
};

const createDeps = ({ sessions, children = {}, messages = {}, events }: DepsOptions): CostDeps => {
  const deps: CostDeps = {
    getSession: (id) => sessions[id],
    getChildren: async (id) => (children[id] ?? []).map((childID) => sessions[childID]),
    getMessages: (id) => messages[id] ?? []
  };
  if (events) {
    deps.getEvents = async (id) => events[id] ?? [];
  }
  return deps;
};

const stepStarted = (
  assistantMessageID: string,
  providerID: string,
  id: string
): DurableEventLike => ({
  type: "session.next.step.started",
  data: { assistantMessageID, model: { providerID, id } }
});

const stepEnded = (assistantMessageID: string, cost: number): DurableEventLike => ({
  type: "session.next.step.ended",
  data: { assistantMessageID, cost }
});

const compaction = (): DurableEventLike => ({ type: "session.next.compaction.ended", data: {} });

test("sums the root and every nested child session", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: { id: "root", cost: 1 },
        child: { id: "child", cost: 2, agent: "coder" },
        grandchild: { id: "grandchild", cost: 3, agent: "coder" }
      },
      children: { root: ["child"], child: ["grandchild"] }
    })
  );

  assert.equal(result.sessions.parent, 1);
  assert.equal(result.sessions.subagent, 5);
  assert.equal(result.total, 6);
});

test("classifies task agents separately from other sub-agents", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: { id: "root", cost: 0.5 },
        explore: { id: "explore", cost: 1.5, agent: "explore" },
        general: { id: "general", cost: 2.5, agent: "general" },
        coder: { id: "coder", cost: 3.5, agent: "coder" }
      },
      children: { root: ["explore", "general", "coder"] }
    })
  );

  assert.equal(result.sessions.parent, 0.5);
  assert.equal(result.sessions.task, 4);
  assert.equal(result.sessions.subagent, 3.5);
  assert.equal(result.total, 8);
});

test("attributes durable step costs per model across several compactions", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: { id: "root", cost: 10.5, model: { providerID: "google", id: "gemini" } }
      },
      events: {
        root: [
          stepStarted("m1", "anthropic", "claude"),
          stepEnded("m1", 4),
          compaction(),
          stepStarted("m2", "openai", "gpt"),
          stepEnded("m2", 6),
          compaction(),
          stepStarted("m3", "google", "gemini"),
          stepEnded("m3", 0.5)
        ]
      }
    })
  );

  assert.equal(result.models["anthropic/claude"], 4);
  assert.equal(result.models["openai/gpt"], 6);
  assert.equal(result.models["google/gemini"], 0.5);
  assert.equal(result.total, 10.5);
});

test("keeps per-step model attribution within one assistant message", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: { root: { id: "root", cost: 3 } },
      events: {
        root: [
          stepStarted("m1", "anthropic", "claude"),
          stepEnded("m1", 1),
          stepStarted("m1", "openai", "gpt"),
          stepEnded("m1", 2)
        ]
      }
    })
  );

  assert.equal(result.models["anthropic/claude"], 1);
  assert.equal(result.models["openai/gpt"], 2);
});

test("distributes an unattributed remainder across the observed models", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: { id: "root", cost: 12, model: { providerID: "google", id: "gemini" } }
      },
      events: {
        root: [
          stepStarted("m1", "anthropic", "claude"),
          stepEnded("m1", 6),
          stepStarted("m2", "openai", "gpt"),
          stepEnded("m2", 2)
        ]
      }
    })
  );

  assert.equal(result.models["anthropic/claude"], 9);
  assert.equal(result.models["openai/gpt"], 3);
  assert.equal(result.models["google/gemini"], undefined);
  assert.equal(result.total, 12);
});

test("attributes steps without a matching start to an unknown model", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: { root: { id: "root", cost: 3, model: { providerID: "openai", id: "gpt" } } },
      events: { root: [stepEnded("missing", 3)] }
    })
  );

  assert.equal(result.models["unknown/unknown"], 3);
});

test("prefers durable events over projected messages", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: { root: { id: "root", cost: 5, model: { providerID: "openai", id: "gpt" } } },
      events: { root: [stepStarted("m1", "anthropic", "claude"), stepEnded("m1", 5)] },
      messages: {
        root: [{ role: "assistant", cost: 5, providerID: "openai", modelID: "gpt" }]
      }
    })
  );

  assert.deepEqual(result.models, { "anthropic/claude": 5 });
});

test("skips model attribution when models are disabled", async () => {
  let eventsCalled = false;
  const deps = createDeps({
    sessions: { root: { id: "root", cost: 5 } },
    events: { root: [stepStarted("m1", "anthropic", "claude"), stepEnded("m1", 5)] }
  });
  deps.getEvents = async (id) => {
    eventsCalled = true;
    return [{ type: "session.next.step.ended", data: { assistantMessageID: id, cost: 5 } }];
  };

  const result = await collectCosts("root", deps, { models: false });

  assert.deepEqual(result.models, {});
  assert.equal(result.total, 5);
  assert.equal(eventsCalled, false);
});

test("attributes message costs per provider/model and spreads the remainder", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: {
          id: "root",
          cost: 10,
          model: { providerID: "anthropic", id: "claude" }
        }
      },
      messages: {
        root: [
          { role: "user" },
          { role: "assistant", cost: 4, providerID: "openai", modelID: "gpt" },
          { role: "assistant", cost: 3, providerID: "openai", modelID: "gpt" }
        ]
      }
    })
  );

  // The 3 of unaccounted cost follow the only observed model, not the session model.
  assert.equal(result.models["openai/gpt"], 10);
  assert.equal(result.models["anthropic/claude"], undefined);
  assert.equal(result.total, 10);
});

test("falls back to the session model when a message has no provider/model", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: { id: "root", cost: 2, model: { providerID: "opencode", id: "zen" } }
      },
      messages: {
        root: [{ role: "assistant", cost: 2 }]
      }
    })
  );

  assert.equal(result.models["opencode/zen"], 2);
});

test("does not double count sessions reachable through multiple parents", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: {
        root: { id: "root", cost: 1 },
        a: { id: "a", cost: 2, agent: "coder" },
        b: { id: "b", cost: 3, agent: "coder" },
        shared: { id: "shared", cost: 4, agent: "coder" }
      },
      children: { root: ["a", "b"], a: ["shared"], b: ["shared"] }
    })
  );

  assert.equal(result.sessions.subagent, 9);
  assert.equal(result.total, 10);
});

test("does not attribute negative remainders", async () => {
  const result = await collectCosts(
    "root",
    createDeps({
      sessions: { root: { id: "root", cost: 1 } },
      messages: {
        root: [{ role: "assistant", cost: 5, providerID: "openai", modelID: "gpt" }]
      }
    })
  );

  assert.deepEqual(result.models, { "openai/gpt": 5 });
});

test("formats the session and model sections with aligned columns", () => {
  const sessionSection = formatSessionSection({ parent: 1, task: 2, subagent: 3 });
  assert.match(sessionSection, /Session:\s+\$1\.00/);
  assert.match(sessionSection, /Total:\s+\$6\.00/);

  const modelSection = formatModelSection({ "openai/gpt-4o": 4, "a/b": 2 }, 6);
  assert.match(modelSection, /openai\/gpt-4o:\s+\$4\.00/);
  assert.match(modelSection, /Total:\s+\$6\.00/);
});

test("formats a full breakdown with both sections", () => {
  const output = formatBreakdown({
    sessions: { parent: 1, task: 0, subagent: 0 },
    models: { "openai/gpt": 1 },
    total: 1
  });

  assert.match(output, /By session/);
  assert.match(output, /By provider\/model/);
});

test("computes a recursive total for every session", () => {
  const totals = computeSessionTreeTotals([
    { id: "root", cost: 1 },
    { id: "child", cost: 2, parentID: "root" },
    { id: "grandchild", cost: 3, parentID: "child" },
    { id: "sibling", cost: 4, parentID: "root" }
  ]);

  assert.equal(totals.get("root"), 10);
  assert.equal(totals.get("child"), 5);
  assert.equal(totals.get("grandchild"), 3);
  assert.equal(totals.get("sibling"), 4);
});

test("treats sessions with unknown parents as roots", () => {
  const totals = computeSessionTreeTotals([
    { id: "orphan", cost: 2, parentID: "missing" },
    { id: "child", cost: 1, parentID: "orphan" }
  ]);

  assert.equal(totals.get("orphan"), 3);
  assert.equal(totals.get("child"), 1);
});

test("treats missing costs as zero", () => {
  const totals = computeSessionTreeTotals([
    { id: "root" },
    { id: "child", parentID: "root" }
  ]);

  assert.equal(totals.get("root"), 0);
  assert.equal(totals.get("child"), 0);
});

test("does not recurse forever on cyclic parents", () => {
  const totals = computeSessionTreeTotals([
    { id: "a", cost: 1, parentID: "b" },
    { id: "b", cost: 2, parentID: "a" }
  ]);

  assert.equal(typeof totals.get("a"), "number");
  assert.equal(typeof totals.get("b"), "number");
});

test("groups recent root sessions by day and sums recursive totals", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const recentlyUpdated = now - 60_000;
  const olderUpdated = now - 2 * DAY_MS;

  const groups = groupSessionsByDay(
    [
      { id: "today-root", cost: 1, time: { updated: recentlyUpdated } },
      {
        id: "today-child",
        cost: 2,
        parentID: "today-root",
        time: { updated: recentlyUpdated }
      },
      { id: "older-root", cost: 3, time: { updated: olderUpdated } },
      { id: "too-old", cost: 9, time: { updated: now - 8 * DAY_MS } }
    ],
    now,
    7
  );

  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "Today");
  assert.equal(groups[0].total, 3);
  assert.equal(groups[0].sessions[0].id, "today-root");
  assert.equal(groups[0].sessions[0].title, "Untitled");
  assert.equal(groups[0].sessions[0].total, 3);
  assert.equal(groups[0].sessions[0].selection, 0);

  assert.equal(groups[1].label, new Date(olderUpdated).toDateString());
  assert.equal(groups[1].total, 3);
  assert.equal(groups[1].sessions[0].selection, 1);
});

test("orders sessions within a day by most recently updated", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);
  const groups = groupSessionsByDay(
    [
      { id: "first", cost: 1, time: { updated: now - 60_000 } },
      { id: "second", cost: 1, time: { updated: now - 30_000 } }
    ],
    now,
    7
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions[0].id, "second");
  assert.equal(groups[0].sessions[0].selection, 0);
  assert.equal(groups[0].sessions[1].id, "first");
  assert.equal(groups[0].sessions[1].selection, 1);
});
