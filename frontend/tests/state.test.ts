import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events";
import { initialState, pendingDecisions, reduce, toolStatus, type OfficeState } from "../src/state";

const join = (agentId: string, ts = 0): AgentEvent => ({
  type: "agent_joined",
  agentId,
  name: agentId.toUpperCase(),
  role: "dev",
  ts,
});

function run(events: AgentEvent[], from: OfficeState = initialState): OfficeState {
  return events.reduce(reduce, from);
}

describe("toolStatus", () => {
  it("classifica ferramentas de leitura, escrita e execução", () => {
    expect(toolStatus("Read")).toBe("reading");
    expect(toolStatus("grep")).toBe("reading");
    expect(toolStatus("Edit")).toBe("writing");
    expect(toolStatus("Write")).toBe("writing");
    expect(toolStatus("Bash")).toBe("running");
  });

  it("trata ferramenta desconhecida como execução", () => {
    expect(toolStatus("mcp__algo__fazer")).toBe("running");
  });
});

describe("reduce", () => {
  it("adiciona agentes livres na ordem de entrada", () => {
    const state = run([join("a"), join("b")]);
    expect(state.order).toEqual(["a", "b"]);
    expect(state.agents.a).toMatchObject({ status: "idle", seq: 0, name: "A" });
    expect(state.agents.b?.seq).toBe(1);
  });

  it("não duplica agente que entra duas vezes e mantém o status", () => {
    const state = run([
      join("a"),
      { type: "task_started", agentId: "a", task: "x", ts: 1 },
      { type: "agent_joined", agentId: "a", name: "Novo", role: "qa", ts: 2 },
    ]);
    expect(state.order).toEqual(["a"]);
    expect(state.agents.a).toMatchObject({ name: "Novo", role: "qa", status: "thinking", seq: 0 });
  });

  it("não reaproveita seq depois que um agente sai", () => {
    const state = run([join("a"), join("b"), { type: "agent_left", agentId: "a", ts: 1 }, join("c")]);
    expect(state.order).toEqual(["b", "c"]);
    expect(state.agents.a).toBeUndefined();
    expect(state.agents.c?.seq).toBe(2);
  });

  it("ignora eventos de agente desconhecido", () => {
    const state = run([join("a")]);
    expect(reduce(state, { type: "thinking", agentId: "fantasma", ts: 1 })).toBe(state);
  });

  it("segue o ciclo de uma tarefa", () => {
    let state = run([join("a"), { type: "task_started", agentId: "a", task: "Criar endpoint", ts: 1 }]);
    expect(state.agents.a).toMatchObject({ status: "thinking", task: "Criar endpoint" });

    state = reduce(state, { type: "tool_started", agentId: "a", tool: "Edit", detail: "api.py", ts: 2 });
    expect(state.agents.a).toMatchObject({ status: "writing", detail: "Edit: api.py" });

    state = reduce(state, { type: "tool_finished", agentId: "a", tool: "Edit", ok: true, ts: 3 });
    expect(state.agents.a?.status).toBe("thinking");

    state = reduce(state, { type: "tool_started", agentId: "a", tool: "Bash", ts: 4 });
    expect(state.agents.a).toMatchObject({ status: "running", detail: "Bash" });

    state = reduce(state, { type: "task_finished", agentId: "a", ok: true, ts: 5 });
    expect(state.agents.a).toMatchObject({ status: "done", lastEventTs: 5 });
  });

  it("falha de ferramenta volta para pensando, não para erro", () => {
    const state = run([
      join("a"),
      { type: "tool_started", agentId: "a", tool: "Bash", ts: 1 },
      { type: "tool_finished", agentId: "a", tool: "Bash", ok: false, ts: 2 },
    ]);
    expect(state.agents.a).toMatchObject({ status: "thinking", detail: "Bash falhou" });
  });

  it("mensagem muda o detalhe sem mudar o status", () => {
    const state = run([
      join("a"),
      { type: "tool_started", agentId: "a", tool: "Read", ts: 1 },
      { type: "message", agentId: "a", text: "olá", ts: 2 },
    ]);
    expect(state.agents.a).toMatchObject({ status: "reading", detail: "olá" });
  });

  it("guarda a pergunta enquanto aguarda decisão e limpa ao responder", () => {
    let state = run([join("a"), join("b"), { type: "waiting_decision", agentId: "a", question: "Pode?", ts: 1 }]);
    expect(state.agents.a).toMatchObject({ status: "waiting", question: "Pode?" });
    expect(pendingDecisions(state)).toBe(1);

    state = reduce(state, { type: "decision_answered", agentId: "a", ts: 2 });
    expect(state.agents.a).toMatchObject({ status: "thinking", question: null });
    expect(pendingDecisions(state)).toBe(0);
  });

  it("resposta sem decisão pendente não muda o status", () => {
    const state = run([
      join("a"),
      { type: "tool_started", agentId: "a", tool: "Read", ts: 1 },
      { type: "decision_answered", agentId: "a", ts: 2 },
    ]);
    expect(state.agents.a?.status).toBe("reading");
  });

  it("limpa a pergunta quando outro evento tira o agente da espera", () => {
    const state = run([
      join("a"),
      { type: "waiting_decision", agentId: "a", question: "Pode?", ts: 1 },
      { type: "error", agentId: "a", message: "caiu", ts: 2 },
    ]);
    expect(state.agents.a).toMatchObject({ status: "error", question: null, detail: "caiu" });
  });

  it("tarefa que falha termina em erro", () => {
    const state = run([join("a"), { type: "task_finished", agentId: "a", ok: false, ts: 1 }]);
    expect(state.agents.a?.status).toBe("error");
  });

  it("não altera o estado recebido", () => {
    const before = run([join("a")]);
    const snapshot = JSON.stringify(before);
    reduce(before, { type: "task_started", agentId: "a", task: "x", ts: 1 });
    reduce(before, { type: "agent_left", agentId: "a", ts: 2 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
