"""Ponto central do backend: guarda o estado e distribui os eventos.

Os adaptadores de provedor publicam aqui; as conexões WebSocket assinam aqui.
Tudo deve ser chamado na thread do loop de eventos do asyncio.
"""

import asyncio
import time
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from .board import Board
from .events import AgentEvent, parse_event, to_wire
from .state import OfficeState

# Eventos que um cliente lento pode acumular antes de ser desconectado.
QUEUE_LIMIT = 1000

# Eventos recentes enviados a quem conecta, para montar o histórico da tela.
HISTORY_LIMIT = 500


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(eq=False)
class Subscription:
    """Estado no momento da assinatura e a fila dos eventos seguintes.

    O snapshot traz também `recent` (os últimos eventos, em ordem de chegada) e
    `board` (tarefas e specs). A fila recebe mensagens prontas para o WebSocket:
    `{"kind": "event", ...}` ou `{"kind": "board", ...}`. Um `None` avisa que o
    assinante ficou para trás e foi removido.
    """

    snapshot: dict[str, Any]
    queue: asyncio.Queue[dict[str, Any] | None]


class Hub:
    def __init__(self, clock: Callable[[], int] = now_ms, board: Board | None = None) -> None:
        self.state = OfficeState()
        self.board = board or Board(clock=clock)
        self.board.on_change(self._board_changed)
        self._clock = clock
        self._subscriptions: set[Subscription] = set()
        self._decisions: dict[str, asyncio.Future[str | None]] = {}
        self._history: deque[dict[str, Any]] = deque(maxlen=HISTORY_LIMIT)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscriptions)

    def publish(self, event: AgentEvent) -> None:
        """Aplica o evento ao estado e entrega a todos os assinantes."""
        self.state.apply(event)
        wire = to_wire(event)
        self._history.append(wire)
        self._broadcast({"kind": "event", "event": wire})

    def emit(self, type: str, agent_id: str, **fields: Any) -> AgentEvent:
        """Monta, valida e publica um evento com o horário atual."""
        event = parse_event(
            {"type": type, "agent_id": agent_id, **fields}, now_ms=self._clock()
        )
        self.publish(event)
        return event

    def ingest(self, data: Any) -> AgentEvent:
        """Valida e publica um evento vindo de fora (JSON já decodificado)."""
        event = parse_event(data, now_ms=self._clock())
        self.publish(event)
        return event

    @contextmanager
    def subscribe(self) -> Iterator[Subscription]:
        # Snapshot e inscrição acontecem sem `await` entre eles, então nenhum
        # evento se perde nem chega duplicado.
        subscription = Subscription(
            snapshot={
                **self.state.snapshot(),
                "recent": list(self._history),
                "board": self.board.summary(),
            },
            queue=asyncio.Queue(maxsize=QUEUE_LIMIT),
        )
        self._subscriptions.add(subscription)
        try:
            yield subscription
        finally:
            self._subscriptions.discard(subscription)

    async def request_decision(
        self, agent_id: str, question: str, timeout: float | None = None
    ) -> str | None:
        """Põe o agente em espera e devolve a resposta do usuário.

        Devolve None se o prazo vencer; nesse caso o agente também sai da espera.
        """
        previous = self._decisions.pop(agent_id, None)
        if previous and not previous.done():
            previous.cancel()

        future: asyncio.Future[str | None] = asyncio.get_running_loop().create_future()
        self._decisions[agent_id] = future
        self.emit("waiting_decision", agent_id, question=question)
        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            self.answer_decision(agent_id, None)
            return None
        finally:
            if self._decisions.get(agent_id) is future:
                del self._decisions[agent_id]

    def answer_decision(self, agent_id: str, answer: str | None) -> bool:
        """Responde a decisão pendente. Devolve False se o agente não esperava."""
        agent = self.state.agents.get(agent_id)
        if agent is None or agent.status != "waiting":
            return False
        self.emit("decision_answered", agent_id, answer=answer or None)
        future = self._decisions.pop(agent_id, None)
        if future and not future.done():
            future.set_result(answer)
        return True

    def _board_changed(self) -> None:
        self._broadcast({"kind": "board", **self.board.summary()})

    def _broadcast(self, message: dict[str, Any]) -> None:
        for subscription in list(self._subscriptions):
            try:
                subscription.queue.put_nowait(message)
            except asyncio.QueueFull:
                self._drop(subscription)

    def _drop(self, subscription: Subscription) -> None:
        self._subscriptions.discard(subscription)
        while not subscription.queue.empty():
            subscription.queue.get_nowait()
        subscription.queue.put_nowait(None)
