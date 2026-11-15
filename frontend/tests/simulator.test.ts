import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events";
import { Simulator } from "../src/simulator";
import { initialState, reduce } from "../src/state";

function collect(seed: number, totalMs: number, stepMs = 16): AgentEvent[] {
  const events: AgentEvent[] = [];
  const simulator = new Simulator({ seed, startTs: 1_000_000 });
  simulator.subscribe((event) => events.push(event));
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) simulator.tick(stepMs);
  return events;
}

describe("Simulator", () => {
  it("é determinístico para a mesma semente", () => {
    expect(collect(7, 60_000)).toEqual(collect(7, 60_000));
    expect(collect(7, 60_000)).not.toEqual(collect(8, 60_000));
  });

  it("não depende do tamanho do tick", () => {
    expect(collect(3, 30_000, 10)).toEqual(collect(3, 30_000, 1000));
  });

  it("coloca os seis agentes no escritório nos primeiros segundos", () => {
    const joined = collect(1, 5_000).filter((e) => e.type === "agent_joined");
    expect(joined.map((e) => e.agentId)).toEqual(["orq", "spec", "be", "fe", "qa", "rev"]);
  });

  it("emite eventos em ordem de tempo, a partir do horário inicial", () => {
    const events = collect(2, 120_000);
    expect(events[0]!.ts).toBeGreaterThanOrEqual(1_000_000);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.ts).toBeGreaterThanOrEqual(events[i - 1]!.ts);
    }
  });

  it("produz uma sequência coerente para cada agente", () => {
    const events = collect(5, 300_000);
    const types = new Set(events.map((e) => e.type));
    for (const type of ["task_started", "tool_started", "tool_finished", "task_finished", "waiting_decision", "decision_answered"]) {
      expect(types).toContain(type);
    }

    const openTool = new Map<string, string | null>();
    for (const event of events) {
      if (event.type === "tool_started") {
        expect(openTool.get(event.agentId) ?? null).toBeNull();
        openTool.set(event.agentId, event.tool);
      } else if (event.type === "tool_finished") {
        expect(openTool.get(event.agentId)).toBe(event.tool);
        openTool.set(event.agentId, null);
      }
    }
  });

  it("resolve a decisão sozinho depois do prazo", () => {
    const events = collect(5, 300_000);
    const asked = events.find((e) => e.type === "waiting_decision")!;
    const answered = events.find(
      (e) => e.type === "decision_answered" && e.agentId === asked.agentId && e.ts >= asked.ts,
    )!;
    expect(answered.ts - asked.ts).toBe(20_000);
  });

  it("answerDecision libera o agente na hora", () => {
    const simulator = new Simulator({ seed: 5, startTs: 0 });
    let state = initialState;
    let waiting: string | null = null;
    simulator.subscribe((event) => {
      state = reduce(state, event);
      if (event.type === "waiting_decision") waiting ??= event.agentId;
    });

    for (let i = 0; i < 20_000 && waiting === null; i++) simulator.tick(16);
    expect(waiting).not.toBeNull();
    expect(state.agents[waiting!]?.status).toBe("waiting");

    expect(simulator.answerDecision(waiting!)).toBe(true);
    expect(state.agents[waiting!]?.status).toBe("thinking");
    expect(simulator.answerDecision(waiting!)).toBe(false);
    expect(simulator.answerDecision("ninguem")).toBe(false);
  });
});
