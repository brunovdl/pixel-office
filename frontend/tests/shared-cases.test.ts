import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events";
import { initialState, reduce, stateFromSnapshot, type AgentState } from "../src/state";

interface Case {
  name: string;
  events: AgentEvent[];
  order: string[];
  nextSeq?: number;
  agents: Record<string, Partial<AgentState>>;
}

// Os mesmos casos rodam no backend (backend/tests/test_state.py).
const cases = JSON.parse(
  readFileSync(new URL("../../shared/reducer-cases.json", import.meta.url), "utf-8"),
) as Case[];

describe("casos compartilhados com o backend", () => {
  it.each(cases)("$name", (testCase) => {
    const state = testCase.events.reduce(reduce, initialState);
    expect(state.order).toEqual(testCase.order);
    if (testCase.nextSeq !== undefined) expect(state.nextSeq).toBe(testCase.nextSeq);
    for (const [id, expected] of Object.entries(testCase.agents)) {
      expect(state.agents[id]).toMatchObject(expected);
    }
  });
});

describe("stateFromSnapshot", () => {
  it("reconstrói o mesmo estado que os eventos produziram", () => {
    const events: AgentEvent[] = [
      { type: "agent_joined", agentId: "b", name: "B", role: "qa", ts: 1 },
      { type: "agent_joined", agentId: "a", name: "A", role: "dev", ts: 2 },
      { type: "waiting_decision", agentId: "a", question: "Pode?", ts: 3 },
    ];
    const state = events.reduce(reduce, initialState);
    const agents = state.order.map((id) => state.agents[id]!);
    expect(stateFromSnapshot(agents, state.nextSeq)).toEqual(state);
  });
});
