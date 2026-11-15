"""Estado do escritório, derivado dos eventos.

Espelha `frontend/src/state.ts`. As duas implementações rodam os mesmos casos de
`shared/reducer-cases.json`; ao mudar uma regra, mude nos dois lados e no arquivo.
"""

from dataclasses import dataclass
from typing import Any, Literal

from .events import (
    AgentEvent,
    AgentJoined,
    AgentLeft,
    DecisionAnswered,
    Error,
    Message,
    TaskFinished,
    TaskStarted,
    Thinking,
    ToolFinished,
    ToolStarted,
    WaitingDecision,
)

AgentStatus = Literal[
    "idle", "thinking", "reading", "writing", "running", "waiting", "done", "error"
]

_READ_TOOLS = {"read", "grep", "glob", "ls", "webfetch", "websearch"}
_WRITE_TOOLS = {"edit", "write", "multiedit", "notebookedit"}


def tool_status(tool: str) -> AgentStatus:
    """Classifica uma ferramenta pelo que o agente aparenta fazer ao usá-la."""
    key = tool.lower()
    if key in _READ_TOOLS:
        return "reading"
    if key in _WRITE_TOOLS:
        return "writing"
    return "running"


@dataclass
class AgentState:
    id: str
    name: str
    role: str
    seq: int
    status: AgentStatus = "idle"
    detail: str = ""
    task: str | None = None
    question: str | None = None
    last_event_ts: int = 0

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "seq": self.seq,
            "status": self.status,
            "detail": self.detail,
            "task": self.task,
            "question": self.question,
            "lastEventTs": self.last_event_ts,
        }


class OfficeState:
    def __init__(self) -> None:
        # A ordem de inserção do dict é a ordem de entrada dos agentes.
        self.agents: dict[str, AgentState] = {}
        self.next_seq = 0

    def apply(self, event: AgentEvent) -> None:
        if isinstance(event, AgentJoined):
            existing = self.agents.get(event.agent_id)
            if existing:
                existing.name = event.name
                existing.role = event.role
                existing.last_event_ts = event.ts
                return
            self.agents[event.agent_id] = AgentState(
                id=event.agent_id,
                name=event.name,
                role=event.role,
                seq=self.next_seq,
                last_event_ts=event.ts,
            )
            self.next_seq += 1
            return

        agent = self.agents.get(event.agent_id)
        if agent is None:
            return
        if isinstance(event, AgentLeft):
            del self.agents[event.agent_id]
            return

        _step(agent, event)
        if agent.status != "waiting":
            agent.question = None
        agent.last_event_ts = event.ts

    def snapshot(self) -> dict[str, Any]:
        return {
            "agents": [agent.to_wire() for agent in self.agents.values()],
            "nextSeq": self.next_seq,
        }


def _step(agent: AgentState, event: AgentEvent) -> None:
    match event:
        case TaskStarted():
            agent.status = "thinking"
            agent.task = event.task
            agent.detail = event.task
        case Thinking():
            agent.status = "thinking"
        case ToolStarted():
            agent.status = tool_status(event.tool)
            agent.detail = f"{event.tool}: {event.detail}" if event.detail else event.tool
        case ToolFinished():
            # Falha de ferramenta é rotina: o modelo lê o erro e segue pensando.
            agent.status = "thinking"
            if not event.ok:
                agent.detail = f"{event.tool} falhou"
        case Message():
            agent.detail = event.text
        case WaitingDecision():
            agent.status = "waiting"
            agent.question = event.question
            agent.detail = event.question
        case DecisionAnswered():
            if agent.status == "waiting":
                agent.status = "thinking"
                agent.detail = "Decisão recebida"
        case TaskFinished():
            agent.status = "done" if event.ok else "error"
            agent.detail = "Tarefa concluída" if event.ok else "Tarefa falhou"
        case Error():
            agent.status = "error"
            agent.detail = event.message
