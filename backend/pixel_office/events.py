"""Protocolo de eventos do harness.

Espelha `frontend/src/events.ts`. No fio os campos vão em camelCase (`agentId`);
no Python usam snake_case (`agent_id`).
"""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from pydantic.alias_generators import to_camel

AgentId = Annotated[str, Field(min_length=1, max_length=64)]
Label = Annotated[str, Field(min_length=1, max_length=200)]
Text = Annotated[str, Field(max_length=4000)]


class _Event(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
    )

    ts: int = Field(ge=0, description="Milissegundos desde a época Unix")
    agent_id: AgentId


class AgentJoined(_Event):
    type: Literal["agent_joined"] = "agent_joined"
    name: Label
    role: Label


class AgentLeft(_Event):
    type: Literal["agent_left"] = "agent_left"


class TaskStarted(_Event):
    type: Literal["task_started"] = "task_started"
    task: Text


class Thinking(_Event):
    type: Literal["thinking"] = "thinking"


class ToolStarted(_Event):
    type: Literal["tool_started"] = "tool_started"
    tool: Label
    detail: Text | None = None


class ToolFinished(_Event):
    type: Literal["tool_finished"] = "tool_finished"
    tool: Label
    ok: bool


class Message(_Event):
    type: Literal["message"] = "message"
    text: Text


class WaitingDecision(_Event):
    type: Literal["waiting_decision"] = "waiting_decision"
    question: Text


class DecisionAnswered(_Event):
    type: Literal["decision_answered"] = "decision_answered"
    answer: Text | None = None


class TaskFinished(_Event):
    type: Literal["task_finished"] = "task_finished"
    ok: bool


class Error(_Event):
    type: Literal["error"] = "error"
    message: Text


AgentEvent = Annotated[
    AgentJoined
    | AgentLeft
    | TaskStarted
    | Thinking
    | ToolStarted
    | ToolFinished
    | Message
    | WaitingDecision
    | DecisionAnswered
    | TaskFinished
    | Error,
    Field(discriminator="type"),
]

_adapter: TypeAdapter[AgentEvent] = TypeAdapter(AgentEvent)


def parse_event(data: Any, *, now_ms: int) -> AgentEvent:
    """Valida um evento recebido. Sem `ts`, usa `now_ms`.

    Levanta `pydantic.ValidationError` se o evento for inválido.
    """
    if isinstance(data, dict) and "ts" not in data:
        data = {**data, "ts": now_ms}
    return _adapter.validate_python(data)


def to_wire(event: AgentEvent) -> dict[str, Any]:
    """Converte o evento para o formato JSON que o frontend lê."""
    return event.model_dump(by_alias=True, exclude_none=True)
