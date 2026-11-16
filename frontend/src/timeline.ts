/** Transforma eventos em itens das conversas e da janela de decisões. Sem DOM. */

import type { AgentEvent } from "./events";

export type EntryKind =
  | "system"
  | "task"
  | "tool"
  | "tool-failed"
  | "message"
  | "question"
  | "answer"
  | "no-answer"
  | "done"
  | "failed"
  | "error";

export interface Entry {
  kind: EntryKind;
  text: string;
  ts: number;
}

/** Item da conversa para o evento, ou null se não aparece na conversa. */
export function toEntry(event: AgentEvent): Entry | null {
  const entry = (kind: EntryKind, text: string): Entry => ({ kind, text, ts: event.ts });
  switch (event.type) {
    case "agent_joined":
      return entry("system", "Entrou no escritório");
    case "agent_left":
      return entry("system", "Saiu do escritório");
    case "task_started":
      return entry("task", event.task);
    case "tool_started":
      return entry("tool", event.detail ? `${event.tool} ${event.detail}` : event.tool);
    case "tool_finished":
      return event.ok ? null : entry("tool-failed", `${event.tool} falhou`);
    case "message":
      return entry("message", event.text);
    case "waiting_decision":
      return entry("question", event.question);
    case "decision_answered":
      return event.answer
        ? entry("answer", event.answer)
        : entry("no-answer", "Seguiu sem resposta");
    case "task_finished":
      return event.ok ? entry("done", "Concluída") : entry("failed", "Não concluída");
    case "error":
      return entry("error", event.message);
    case "thinking":
      return null;
  }
}

export interface AnsweredDecision {
  agentId: string;
  question: string;
  /** null quando o agente seguiu sem resposta. */
  answer: string | null;
  ts: number;
}

/** Decisões já respondidas, da mais recente para a mais antiga. */
export function answeredDecisions(
  events: readonly AgentEvent[],
  limit: number,
): AnsweredDecision[] {
  const asked = new Map<string, string>();
  const answered: AnsweredDecision[] = [];
  for (const event of events) {
    if (event.type === "waiting_decision") asked.set(event.agentId, event.question);
    if (event.type !== "decision_answered") continue;
    const question = asked.get(event.agentId);
    if (question === undefined) continue;
    asked.delete(event.agentId);
    answered.push({
      agentId: event.agentId,
      question,
      answer: event.answer ?? null,
      ts: event.ts,
    });
  }
  return answered.reverse().slice(0, limit);
}
