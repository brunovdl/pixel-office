/** Painel lateral: lista do time e registro de eventos. */

import type { AgentEvent } from "./events";
import { shirtColor } from "./look";
import type { AgentStatus, OfficeState } from "./state";

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Livre",
  thinking: "Pensando",
  reading: "Lendo",
  writing: "Editando",
  running: "Executando",
  waiting: "Aguardando decisão",
  done: "Concluiu",
  error: "Erro",
};

const MAX_LOG = 80;

/** Texto do evento para o registro, ou null se não vale mostrar. */
export function describe(event: AgentEvent): string | null {
  switch (event.type) {
    case "agent_joined":
      return "entrou no escritório";
    case "agent_left":
      return "saiu do escritório";
    case "task_started":
      return `começou: ${event.task}`;
    case "tool_started":
      return event.detail ? `${event.tool} ${event.detail}` : event.tool;
    case "tool_finished":
      return event.ok ? null : `${event.tool} falhou`;
    case "message":
      return `"${event.text}"`;
    case "waiting_decision":
      return `pede decisão: ${event.question}`;
    case "decision_answered":
      return "recebeu a decisão";
    case "task_finished":
      return event.ok ? "concluiu a tarefa" : "não concluiu a tarefa";
    case "error":
      return `erro: ${event.message}`;
    case "thinking":
      return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class Panel {
  constructor(
    private readonly agentsEl: HTMLElement,
    private readonly logEl: HTMLElement,
    private readonly onAnswer: (agentId: string) => void,
  ) {}

  renderAgents(state: OfficeState): void {
    const cards = state.order.map((id) => {
      const agent = state.agents[id]!;
      const card = el("li", `agent status-${agent.status}`);

      const head = el("div", "agent-head");
      const dot = el("span", "agent-dot");
      dot.style.background = shirtColor(agent.seq);
      head.append(dot, el("strong", "agent-name", agent.name));
      head.append(el("span", "agent-status", STATUS_LABEL[agent.status]));
      card.append(head);

      card.append(el("div", "agent-role", agent.role));
      if (agent.status !== "idle" && agent.detail) {
        card.append(el("div", "agent-detail", agent.detail));
      }
      if (agent.status === "waiting") {
        const button = el("button", "agent-answer", "Responder");
        button.type = "button";
        button.addEventListener("click", () => this.onAnswer(agent.id));
        card.append(button);
      }
      return card;
    });
    this.agentsEl.replaceChildren(...cards);
  }

  addEvent(event: AgentEvent, state: OfficeState): void {
    const text = describe(event);
    if (text === null) return;
    const name = state.agents[event.agentId]?.name ?? event.agentId;
    const time = new Date(event.ts).toLocaleTimeString("pt-BR");

    const item = el("li", `log-item log-${event.type}`);
    item.append(el("time", "log-time", time), el("strong", "log-name", name));
    item.append(el("span", "log-text", text));
    this.logEl.prepend(item);
    while (this.logEl.childElementCount > MAX_LOG) this.logEl.lastElementChild?.remove();
  }
}
