/** Conteúdo das janelas e dos painéis fixos. */

import type { EventHistory } from "./history";
import type { OfficeState } from "./state";
import { answeredDecisions, toEntry } from "./timeline";
import {
  AnswerForms,
  STATUS_LABEL,
  agentDot,
  agentName,
  button,
  describe,
  el,
  formatTime,
  replaceKeepingFocus,
} from "./ui";

type Pick = (agentId: string) => void;

// ------------------------------------------------------------ painel lateral

export function renderTeam(list: HTMLElement, state: OfficeState, onPick: Pick): void {
  list.replaceChildren(
    ...state.order.map((id) => {
      const agent = state.agents[id]!;
      const item = el("li", `team-item status-${agent.status}`);
      const pick = button("team-btn", "", () => onPick(id));
      pick.title = agent.detail || agent.role;
      pick.append(
        agentDot(agent),
        el("span", "team-name", agent.name),
        el("span", "team-status", STATUS_LABEL[agent.status]),
      );
      item.append(pick);
      return item;
    }),
  );
}

const LOG_LIMIT = 150;

export function renderLog(list: HTMLElement, state: OfficeState, history: EventHistory): void {
  const items: HTMLElement[] = [];
  const events = history.all;
  for (let i = events.length - 1; i >= 0 && items.length < LOG_LIMIT; i--) {
    const event = events[i]!;
    const text = describe(event);
    if (text === null) continue;
    const item = el("li", `log-item log-${event.type}`);
    item.append(
      el("time", "log-time", formatTime(event.ts)),
      el("strong", "log-name", agentName(state, event.agentId, events)),
      el("span", "log-text", text),
    );
    items.push(item);
  }
  list.replaceChildren(...items);
}

export function renderAgentBar(bar: HTMLElement, state: OfficeState, onPick: Pick): void {
  bar.replaceChildren(
    ...state.order.map((id) => {
      const agent = state.agents[id]!;
      const chip = button(`chip status-${agent.status}`, "", () => onPick(id));
      chip.title = `${agent.name}: ${STATUS_LABEL[agent.status]}`;
      chip.append(agentDot(agent), el("span", "chip-name", agent.name));
      return chip;
    }),
  );
}

// --------------------------------------------------------------- conversas

export class ConversationsView {
  private selected: string | null = null;
  private readonly list = el("ul", "conv-list");
  private readonly head = el("header", "conv-head");
  private readonly timeline = el("ol", "conv-timeline");
  private readonly foot = el("footer", "conv-foot");
  private shownAgent: string | null = null;
  private shownVersion = -1;

  constructor(
    body: HTMLElement,
    private readonly forms: AnswerForms,
    private readonly onSelect: () => void,
  ) {
    const pane = el("section", "conv-pane");
    pane.append(this.head, this.timeline, this.foot);
    body.append(this.list, pane);
  }

  select(agentId: string): void {
    this.selected = agentId;
  }

  render(state: OfficeState, history: EventHistory): void {
    if (!this.selected || !state.agents[this.selected]) this.selected = state.order[0] ?? null;
    const selected = this.selected;

    this.list.replaceChildren(
      ...state.order.map((id) => {
        const agent = state.agents[id]!;
        const item = el("li");
        const pick = button(`conv-agent status-${agent.status}`, "", () => {
          this.select(id);
          this.onSelect();
        });
        pick.classList.toggle("is-selected", id === selected);
        pick.setAttribute("aria-current", String(id === selected));
        pick.append(agentDot(agent), el("span", "conv-agent-name", agent.name));
        if (agent.status === "waiting") pick.append(el("span", "conv-flag", "?"));
        item.append(pick);
        return item;
      }),
    );

    if (!selected) {
      this.head.replaceChildren(el("span", "muted", "Nenhum agente no escritório."));
      this.timeline.replaceChildren();
      this.foot.replaceChildren();
      return;
    }

    const agent = state.agents[selected]!;
    const status = el("span", `conv-status status-${agent.status}`, STATUS_LABEL[agent.status]);
    const title = el("div", "conv-title");
    title.append(el("strong", "", agent.name), el("span", "muted", agent.role));
    this.head.replaceChildren(title, status);

    if (selected !== this.shownAgent || history.version !== this.shownVersion) {
      const switched = selected !== this.shownAgent;
      const box = this.timeline;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.replaceChildren(...this.entries(history, selected, agent.name));
      if (switched || atBottom) box.scrollTop = box.scrollHeight;
      this.shownAgent = selected;
      this.shownVersion = history.version;
    }

    if (agent.status === "waiting" && agent.question) {
      const question = el("p", "conv-question");
      question.append(el("strong", "", "Pergunta: "), document.createTextNode(agent.question));
      replaceKeepingFocus(this.foot, [question, this.forms.form(selected, "conv")]);
    } else {
      replaceKeepingFocus(this.foot, [
        el("p", "muted", "Quando o agente pedir uma decisão, você responde aqui."),
      ]);
    }
  }

  private entries(history: EventHistory, agentId: string, name: string): HTMLElement[] {
    const items: HTMLElement[] = [];
    for (const event of history.forAgent(agentId)) {
      const entry = toEntry(event);
      if (!entry) continue;
      const item = el("li", `entry entry-${entry.kind}`);
      const meta = el("div", "entry-meta");
      const who =
        entry.kind === "answer" ? "Você" : entry.kind === "message" ? name : null;
      if (who) meta.append(el("strong", "", who));
      meta.append(el("time", "", formatTime(entry.ts)));
      item.append(meta, el("div", "entry-text", entry.text));
      items.push(item);
    }
    if (items.length === 0) items.push(el("li", "entry muted", "Sem atividade recente."));
    return items;
  }
}

// ---------------------------------------------------------------- decisões

export class DecisionsView {
  constructor(
    private readonly body: HTMLElement,
    private readonly forms: AnswerForms,
    private readonly onOpenConversation: Pick,
  ) {}

  render(state: OfficeState, history: EventHistory): void {
    const nodes: HTMLElement[] = [];
    const pending = state.order
      .map((id) => state.agents[id]!)
      .filter((agent) => agent.status === "waiting" && agent.question);

    if (pending.length === 0) {
      nodes.push(el("p", "empty", "Nenhuma decisão pendente no momento."));
    }
    for (const agent of pending) {
      const card = el("article", "decision");
      const head = el("div", "decision-head");
      head.append(
        agentDot(agent),
        el("strong", "", agent.name),
        el("time", "muted", `desde ${formatTime(agent.lastEventTs)}`),
        button("link", "Abrir conversa", () => this.onOpenConversation(agent.id)),
      );
      card.append(head, el("p", "decision-question", agent.question!));
      card.append(this.forms.form(agent.id, "decisions"));
      nodes.push(card);
    }

    const answered = answeredDecisions(history.all, 15);
    if (answered.length > 0) {
      nodes.push(el("h3", "section-title", "Respondidas recentemente"));
      const list = el("ol", "answered");
      for (const item of answered) {
        const row = el("li", "answered-item");
        const head = el("div", "answered-head");
        head.append(
          el("strong", "", agentName(state, item.agentId, history.all)),
          el("time", "muted", formatTime(item.ts)),
        );
        row.append(head, el("div", "answered-question", item.question));
        row.append(
          item.answer === null
            ? el("div", "answered-answer muted", "Seguiu sem resposta")
            : el("div", "answered-answer", `→ ${item.answer}`),
        );
        list.append(row);
      }
      nodes.push(list);
    }

    replaceKeepingFocus(this.body, nodes);
  }
}

// ----------------------------------------------------------------- agentes

export class AgentsView {
  constructor(
    private readonly body: HTMLElement,
    private readonly onOpenConversation: Pick,
  ) {}

  render(state: OfficeState): void {
    if (state.order.length === 0) {
      this.body.replaceChildren(el("p", "empty", "Nenhum agente no escritório."));
      return;
    }
    const grid = el("div", "agent-grid");
    for (const id of state.order) {
      const agent = state.agents[id]!;
      const card = el("article", `agent-card status-${agent.status}`);
      const head = el("div", "agent-card-head");
      head.append(
        agentDot(agent),
        el("strong", "agent-card-name", agent.name),
        el("span", "agent-card-status", STATUS_LABEL[agent.status]),
      );
      const facts = el("dl", "facts");
      const fact = (label: string, value: string) => {
        facts.append(el("dt", "", label), el("dd", "", value));
      };
      fact("Papel", agent.role);
      fact("Tarefa", agent.task ?? "—");
      fact("Agora", agent.status === "idle" ? "—" : agent.detail || "—");
      fact("Atividade", formatTime(agent.lastEventTs));
      card.append(
        head,
        facts,
        button("link", "Abrir conversa", () => this.onOpenConversation(id)),
      );
      grid.append(card);
    }
    this.body.replaceChildren(grid);
  }
}
