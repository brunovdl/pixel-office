import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/events";
import type { OfficeState } from "../src/state";
import { WebSocketFeed, type ConnectionStatus, type SocketLike } from "../src/wsfeed";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const snapshots: [OfficeState, AgentEvent[]][] = [];
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const feed = new WebSocketFeed({
    url: "ws://teste/ws",
    onSnapshot: (state, recent) => snapshots.push([state, recent]),
    onStatus: (status) => statuses.push(status),
    onServerError: (message) => errors.push(message),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  feed.subscribe((event) => events.push(event));
  return { feed, sockets, statuses, snapshots, events, errors };
}

const AGENT = {
  id: "a",
  name: "A",
  role: "dev",
  seq: 0,
  status: "waiting",
  detail: "Pode?",
  task: null,
  question: "Pode?",
  lastEventTs: 3,
};

describe("WebSocketFeed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("conecta ao iniciar e informa o status", () => {
    const { feed, sockets, statuses } = setup();
    feed.start();
    feed.start();
    expect(sockets.map((s) => s.url)).toEqual(["ws://teste/ws"]);
    sockets[0]!.onopen?.();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("entrega o snapshot como estado e os eventos aos ouvintes", () => {
    const { feed, sockets, snapshots, events } = setup();
    feed.start();
    const joined = { type: "agent_joined", agentId: "a", name: "A", role: "dev", ts: 1 };
    sockets[0]!.receive({ kind: "snapshot", agents: [AGENT], nextSeq: 1, recent: [joined] });
    sockets[0]!.receive({ kind: "snapshot", agents: [], nextSeq: 0 });
    expect(snapshots).toEqual([
      [{ agents: { a: AGENT }, order: ["a"], nextSeq: 1 }, [joined]],
      [{ agents: {}, order: [], nextSeq: 0 }, []],
    ]);

    const event = { type: "thinking", agentId: "a", ts: 4 };
    sockets[0]!.receive({ kind: "event", event });
    expect(events).toEqual([event]);
  });

  it("entrega o quadro do snapshot e das atualizações", () => {
    const boards: unknown[] = [];
    const sockets: FakeSocket[] = [];
    const feed = new WebSocketFeed({
      url: "ws://teste/ws",
      onSnapshot: () => {},
      onBoard: (board) => boards.push(board),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    feed.start();
    const board = { tasks: [], specs: [{ id: 1 }] };
    sockets[0]!.receive({ kind: "snapshot", agents: [], nextSeq: 0, board });
    sockets[0]!.receive({ kind: "board", tasks: [{ id: 2 }], specs: [] });
    sockets[0]!.receive({ kind: "snapshot", agents: [], nextSeq: 0 });
    expect(boards).toEqual([board, { tasks: [{ id: 2 }], specs: [] }]);
  });

  it("repassa recusas do backend e ignora mensagens que não entende", () => {
    const { feed, sockets, snapshots, events, errors } = setup();
    feed.start();
    sockets[0]!.receive({ kind: "error", message: "não aguarda" });
    sockets[0]!.receive("isto não é json");
    sockets[0]!.receive({ kind: "novidade" });
    sockets[0]!.receive({ kind: "snapshot" });
    expect(errors).toEqual(["não aguarda"]);
    expect(snapshots).toEqual([]);
    expect(events).toEqual([]);
  });

  it("envia a resposta de decisão no formato do backend", () => {
    const { feed, sockets } = setup();
    feed.answerDecision("a", "antes de conectar");
    feed.start();
    feed.answerDecision("a", "Pode");
    expect(sockets[0]!.sent.map((text) => JSON.parse(text))).toEqual([
      { kind: "answer_decision", agentId: "a", answer: "Pode" },
    ]);
  });

  it("reconecta com espera crescente e zera a espera ao conectar", () => {
    const { feed, sockets, statuses } = setup();
    feed.start();
    sockets[0]!.close();
    expect(statuses.at(-1)).toBe("closed");

    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.close();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2]!.onopen?.();
    sockets[2]!.close();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
  });

  it("não reconecta depois de parar", () => {
    const { feed, sockets } = setup();
    feed.start();
    feed.stop();
    expect(sockets[0]!.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    feed.start();
    sockets[1]!.close();
    feed.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });
});
