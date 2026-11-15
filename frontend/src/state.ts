import type { AgentEvent } from "./events";

export type AgentStatus =
  | "idle"
  | "thinking"
  | "reading"
  | "writing"
  | "running"
  | "waiting"
  | "done"
  | "error";

export interface AgentState {
  id: string;
  name: string;
  role: string;
  /** Ordem de entrada no escritório; não muda quando outros agentes saem. */
  seq: number;
  status: AgentStatus;
  /** Texto curto do que o agente está fazendo agora. */
  detail: string;
  task: string | null;
  /** Pergunta pendente, quando o status é "waiting". */
  question: string | null;
  lastEventTs: number;
}

export interface OfficeState {
  agents: Readonly<Record<string, AgentState>>;
  /** Ids na ordem de entrada. */
  order: readonly string[];
  nextSeq: number;
}

export const initialState: OfficeState = { agents: {}, order: [], nextSeq: 0 };

const READ_TOOLS = new Set(["read", "grep", "glob", "ls", "webfetch", "websearch"]);
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

/** Classifica uma ferramenta pelo que o agente aparenta fazer ao usá-la. */
export function toolStatus(tool: string): AgentStatus {
  const key = tool.toLowerCase();
  if (READ_TOOLS.has(key)) return "reading";
  if (WRITE_TOOLS.has(key)) return "writing";
  return "running";
}

/** Aplica um evento ao estado. Função pura: nunca altera o estado recebido. */
export function reduce(state: OfficeState, event: AgentEvent): OfficeState {
  if (event.type === "agent_joined") {
    const existing = state.agents[event.agentId];
    if (existing) {
      return withAgent(state, {
        ...existing,
        name: event.name,
        role: event.role,
        lastEventTs: event.ts,
      });
    }
    const agent: AgentState = {
      id: event.agentId,
      name: event.name,
      role: event.role,
      seq: state.nextSeq,
      status: "idle",
      detail: "",
      task: null,
      question: null,
      lastEventTs: event.ts,
    };
    return {
      agents: { ...state.agents, [agent.id]: agent },
      order: [...state.order, agent.id],
      nextSeq: state.nextSeq + 1,
    };
  }

  const agent = state.agents[event.agentId];
  if (!agent) return state;

  if (event.type === "agent_left") {
    const agents = { ...state.agents };
    delete agents[event.agentId];
    return {
      ...state,
      agents,
      order: state.order.filter((id) => id !== event.agentId),
    };
  }

  const next = step(agent, event);
  if (next.status !== "waiting") next.question = null;
  next.lastEventTs = event.ts;
  return withAgent(state, next);
}

type WorkEvent = Exclude<AgentEvent, { type: "agent_joined" | "agent_left" }>;

function step(agent: AgentState, event: WorkEvent): AgentState {
  const next = { ...agent };
  switch (event.type) {
    case "task_started":
      next.status = "thinking";
      next.task = event.task;
      next.detail = event.task;
      break;
    case "thinking":
      next.status = "thinking";
      break;
    case "tool_started":
      next.status = toolStatus(event.tool);
      next.detail = event.detail ? `${event.tool}: ${event.detail}` : event.tool;
      break;
    case "tool_finished":
      // Falha de ferramenta é rotina: o modelo lê o erro e segue pensando.
      next.status = "thinking";
      if (!event.ok) next.detail = `${event.tool} falhou`;
      break;
    case "message":
      next.detail = event.text;
      break;
    case "waiting_decision":
      next.status = "waiting";
      next.question = event.question;
      next.detail = event.question;
      break;
    case "decision_answered":
      if (agent.status === "waiting") {
        next.status = "thinking";
        next.detail = "Decisão recebida";
      }
      break;
    case "task_finished":
      next.status = event.ok ? "done" : "error";
      next.detail = event.ok ? "Tarefa concluída" : "Tarefa falhou";
      break;
    case "error":
      next.status = "error";
      next.detail = event.message;
      break;
  }
  return next;
}

function withAgent(state: OfficeState, agent: AgentState): OfficeState {
  return { ...state, agents: { ...state.agents, [agent.id]: agent } };
}

export function pendingDecisions(state: OfficeState): number {
  return state.order.filter((id) => state.agents[id]?.status === "waiting").length;
}
