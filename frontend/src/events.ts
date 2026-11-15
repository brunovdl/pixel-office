/**
 * Protocolo de eventos do harness.
 *
 * Todo provedor (Claude Code, Groq, ...) deve ser traduzido para estes eventos.
 * O escritório só conhece este formato, nunca o formato nativo do provedor.
 */

interface BaseEvent {
  /** Momento do evento, em milissegundos desde a época Unix. */
  ts: number;
  agentId: string;
}

export type AgentEvent =
  | (BaseEvent & { type: "agent_joined"; name: string; role: string })
  | (BaseEvent & { type: "agent_left" })
  | (BaseEvent & { type: "task_started"; task: string })
  | (BaseEvent & { type: "thinking" })
  | (BaseEvent & { type: "tool_started"; tool: string; detail?: string })
  | (BaseEvent & { type: "tool_finished"; tool: string; ok: boolean })
  | (BaseEvent & { type: "message"; text: string })
  | (BaseEvent & { type: "waiting_decision"; question: string })
  | (BaseEvent & { type: "decision_answered"; answer?: string })
  | (BaseEvent & { type: "task_finished"; ok: boolean })
  | (BaseEvent & { type: "error"; message: string });

export type AgentEventType = AgentEvent["type"];

export type EventListener = (event: AgentEvent) => void;

/** Origem de eventos: o backend por WebSocket ou o simulador local. */
export interface EventFeed {
  /** Registra um ouvinte e devolve a função que cancela o registro. */
  subscribe(listener: EventListener): () => void;
  /** Envia a resposta do usuário ao agente que aguarda decisão. */
  answerDecision(agentId: string, answer: string): void;
}
