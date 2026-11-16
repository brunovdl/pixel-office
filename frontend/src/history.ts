/** Eventos recentes, para o log e o histórico de cada agente. */

import type { AgentEvent } from "./events";

export class EventHistory {
  private events: AgentEvent[] = [];
  /** Muda a cada alteração; as telas usam para saber se precisam redesenhar. */
  version = 0;

  constructor(private readonly limit = 1000) {}

  add(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
    this.version++;
  }

  /** Troca tudo, como ao receber o histórico do backend na conexão. */
  replace(events: readonly AgentEvent[]): void {
    this.events = events.slice(-this.limit);
    this.version++;
  }

  get all(): readonly AgentEvent[] {
    return this.events;
  }

  forAgent(agentId: string): AgentEvent[] {
    return this.events.filter((event) => event.agentId === agentId);
  }
}
