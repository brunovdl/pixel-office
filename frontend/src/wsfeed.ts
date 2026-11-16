/** Recebe os eventos do backend por WebSocket e reconecta sozinho. */

import type { AgentEvent, EventFeed, EventListener } from "./events";
import { stateFromSnapshot, type AgentState, type OfficeState } from "./state";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** A parte de `WebSocket` que o feed usa; permite trocar por um falso nos testes. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WebSocketFeedOptions {
  url: string;
  /** Chamado a cada conexão, com o estado completo e os eventos recentes. */
  onSnapshot: (state: OfficeState, recent: AgentEvent[]) => void;
  onStatus?: (status: ConnectionStatus) => void;
  /** Recusas do backend, como responder a quem não aguarda decisão. */
  onServerError?: (message: string) => void;
  createSocket?: (url: string) => SocketLike;
}

type ServerMessage =
  | { kind: "snapshot"; agents: AgentState[]; nextSeq: number; recent?: AgentEvent[] }
  | { kind: "event"; event: AgentEvent }
  | { kind: "error"; message: string };

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10000;

export class WebSocketFeed implements EventFeed {
  private readonly listeners = new Set<EventListener>();
  private socket: SocketLike | null = null;
  private retryMs = FIRST_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly options: WebSocketFeedOptions) {}

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  answerDecision(agentId: string, answer: string): void {
    this.socket?.send(JSON.stringify({ kind: "answer_decision", agentId, answer }));
  }

  private connect(): void {
    this.options.onStatus?.("connecting");
    const create = this.options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
    const socket = create(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.options.onStatus?.("open");
    };
    socket.onmessage = (message) => this.handle(message.data);
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.options.onStatus?.("closed");
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    };
  }

  private handle(data: unknown): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    if (message.kind === "snapshot" && Array.isArray(message.agents)) {
      const recent = Array.isArray(message.recent) ? message.recent : [];
      this.options.onSnapshot(stateFromSnapshot(message.agents, message.nextSeq), recent);
    } else if (message.kind === "event" && message.event) {
      for (const listener of this.listeners) listener(message.event);
    } else if (message.kind === "error") {
      this.options.onServerError?.(message.message);
    }
  }
}
