import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events";
import { EventHistory } from "../src/history";
import { answeredDecisions, toEntry } from "../src/timeline";
import { describe as describeEvent } from "../src/ui";

describe("toEntry", () => {
  it("mostra tarefa, ferramentas, mensagens e fim", () => {
    const events: AgentEvent[] = [
      { type: "task_started", agentId: "a", task: "Criar endpoint", ts: 1 },
      { type: "thinking", agentId: "a", ts: 2 },
      { type: "tool_started", agentId: "a", tool: "Bash", detail: "pytest", ts: 3 },
      { type: "tool_finished", agentId: "a", tool: "Bash", ok: true, ts: 4 },
      { type: "tool_finished", agentId: "a", tool: "Bash", ok: false, ts: 5 },
      { type: "message", agentId: "a", text: "Pronto", ts: 6 },
      { type: "task_finished", agentId: "a", ok: true, ts: 7 },
    ];
    expect(events.map(toEntry).filter(Boolean).map((e) => [e!.kind, e!.text])).toEqual([
      ["task", "Criar endpoint"],
      ["tool", "Bash pytest"],
      ["tool-failed", "Bash falhou"],
      ["message", "Pronto"],
      ["done", "Concluída"],
    ]);
  });

  it("separa resposta do usuário de decisão sem resposta", () => {
    expect(toEntry({ type: "decision_answered", agentId: "a", answer: "Pode", ts: 1 })).toEqual({
      kind: "answer",
      text: "Pode",
      ts: 1,
    });
    expect(toEntry({ type: "decision_answered", agentId: "a", ts: 1 })?.kind).toBe("no-answer");
  });
});

describe("answeredDecisions", () => {
  it("junta pergunta e resposta, da mais recente para a mais antiga", () => {
    const events: AgentEvent[] = [
      { type: "waiting_decision", agentId: "a", question: "Q1", ts: 1 },
      { type: "waiting_decision", agentId: "b", question: "Q2", ts: 2 },
      { type: "decision_answered", agentId: "a", answer: "R1", ts: 3 },
      { type: "decision_answered", agentId: "b", ts: 4 },
      { type: "decision_answered", agentId: "a", answer: "sem pergunta", ts: 5 },
      { type: "waiting_decision", agentId: "a", question: "Q3", ts: 6 },
    ];
    expect(answeredDecisions(events, 10)).toEqual([
      { agentId: "b", question: "Q2", answer: null, ts: 4 },
      { agentId: "a", question: "Q1", answer: "R1", ts: 3 },
    ]);
    expect(answeredDecisions(events, 1)).toHaveLength(1);
  });
});

describe("EventHistory", () => {
  const event = (ts: number): AgentEvent => ({ type: "thinking", agentId: ts % 2 ? "a" : "b", ts });

  it("guarda só os mais recentes e muda a versão", () => {
    const history = new EventHistory(3);
    for (let ts = 1; ts <= 5; ts++) history.add(event(ts));
    expect(history.all.map((e) => e.ts)).toEqual([3, 4, 5]);
    expect(history.version).toBe(5);
    expect(history.forAgent("a").map((e) => e.ts)).toEqual([3, 5]);
  });

  it("replace troca tudo respeitando o limite", () => {
    const history = new EventHistory(2);
    history.add(event(1));
    history.replace([event(7), event(8), event(9)]);
    expect(history.all.map((e) => e.ts)).toEqual([8, 9]);
    expect(history.version).toBe(2);
  });
});

describe("describe", () => {
  it("descreve para o log e omite o que não interessa", () => {
    expect(describeEvent({ type: "tool_started", agentId: "a", tool: "Read", detail: "x.py", ts: 1 })).toBe("usa Read · x.py");
    expect(describeEvent({ type: "thinking", agentId: "a", ts: 1 })).toBeNull();
    expect(describeEvent({ type: "tool_finished", agentId: "a", tool: "Read", ok: true, ts: 1 })).toBeNull();
  });
});
