/** Peças comuns das telas: textos de status, criação de elementos e respostas. */

import type { AgentEvent } from "./events";
import { shirtColor } from "./look";
import type { AgentState, AgentStatus, OfficeState } from "./state";

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Livre",
  thinking: "Pensando",
  reading: "Lendo",
  writing: "Editando",
  running: "Executando",
  waiting: "Aguardando decisão",
  done: "Concluiu",
  error: "Erro",
};

/** Texto do evento para o log, ou null se não vale mostrar. */
export function describe(event: AgentEvent): string | null {
  switch (event.type) {
    case "agent_joined":
      return "entrou no escritório";
    case "agent_left":
      return "saiu do escritório";
    case "task_started":
      return `começou: ${event.task}`;
    case "tool_started":
      return event.detail ? `usa ${event.tool} · ${event.detail}` : `usa ${event.tool}`;
    case "tool_finished":
      return event.ok ? null : `${event.tool} falhou`;
    case "message":
      return `"${event.text}"`;
    case "waiting_decision":
      return `pede decisão: ${event.question}`;
    case "decision_answered":
      return event.answer ? `recebeu a decisão: ${event.answer}` : "seguiu sem resposta";
    case "task_finished":
      return event.ok ? "concluiu a tarefa" : "não concluiu a tarefa";
    case "error":
      return `erro: ${event.message}`;
    case "thinking":
      return null;
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR");
}

export function agentDot(agent: AgentState): HTMLElement {
  const dot = el("span", "agent-dot");
  dot.style.background = shirtColor(agent.seq);
  return dot;
}

/** Nome do agente, mesmo que ele já tenha saído: procura a última entrada no histórico. */
export function agentName(
  state: OfficeState,
  agentId: string,
  events: readonly AgentEvent[] = [],
): string {
  const current = state.agents[agentId]?.name;
  if (current) return current;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "agent_joined" && event.agentId === agentId) return event.name;
  }
  return agentId;
}

/**
 * Troca o conteúdo sem tirar o foco do campo em que o usuário digita.
 * O campo é reconhecido pelo atributo `data-focus-key`.
 */
export function replaceKeepingFocus(container: HTMLElement, nodes: Node[]): void {
  const active = document.activeElement;
  const editing =
    active instanceof HTMLInputElement && container.contains(active) ? active : null;
  const key = editing?.dataset.focusKey;
  const start = editing?.selectionStart ?? null;
  const end = editing?.selectionEnd ?? null;

  container.replaceChildren(...nodes);

  if (!key) return;
  const next = container.querySelector<HTMLInputElement>(
    `[data-focus-key="${CSS.escape(key)}"]`,
  );
  if (!next) return;
  next.focus({ preventScroll: true });
  next.setSelectionRange(start, end);
}

/** Formulários de resposta às decisões, com rascunho compartilhado entre janelas. */
export class AnswerForms {
  private readonly drafts = new Map<string, string>();

  constructor(private readonly onAnswer: (agentId: string, answer: string) => void) {}

  /** Esquece rascunhos de quem não aguarda mais decisão. */
  prune(state: OfficeState): void {
    for (const id of this.drafts.keys()) {
      if (state.agents[id]?.status !== "waiting") this.drafts.delete(id);
    }
  }

  /** `place` distingue o mesmo agente em janelas diferentes. */
  form(agentId: string, place: string): HTMLFormElement {
    const form = el("form", "answer");
    const input = el("input", "answer-input");
    input.type = "text";
    input.placeholder = "Sua resposta";
    input.maxLength = 4000;
    input.autocomplete = "off";
    input.dataset.focusKey = `${place}:${agentId}`;
    input.setAttribute("aria-label", "Resposta para o agente");
    input.value = this.drafts.get(agentId) ?? "";
    input.addEventListener("input", () => this.drafts.set(agentId, input.value));

    const send = el("button", "answer-send", "Responder");
    send.type = "submit";
    form.append(input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const answer = input.value.trim();
      if (!answer) {
        input.focus();
        return;
      }
      this.drafts.delete(agentId);
      this.onAnswer(agentId, answer);
    });
    return form;
  }
}
