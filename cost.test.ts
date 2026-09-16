import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectCosts,
  formatBreakdown,
  formatModelSection,
  formatSessionSection,
  type CostDeps,
  type MessageLike,
  type SessionLike
} from "./cost.ts";

type DepsOptions = {
  sessions: Record<string, SessionLike>;
  children?: Record<string, string[]>;
  messages?: Record<string, MessageLike[]>;
};

const createDeps = ({ sessions, children = {}, messages = {} }: DepsOptions): CostDeps => ({
  getSession: (id) => sessions[id],
  getChildren: async (id) => (children[id] ?? []).map((childID) => sessions[childID]),
  getMessages: (id) => messages[id] ?? []
});

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

test("attributes message costs per provider/model and adds the remainder", async () => {
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

  assert.equal(result.models["openai/gpt"], 7);
  assert.equal(result.models["anthropic/claude"], 3);
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