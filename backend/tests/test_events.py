import pytest
from pydantic import ValidationError

from pixel_office.events import ToolStarted, parse_event, to_wire


def test_parses_camel_case_and_fills_missing_ts():
    event = parse_event({"type": "tool_started", "agentId": "a", "tool": "Read"}, now_ms=42)
    assert isinstance(event, ToolStarted)
    assert (event.agent_id, event.ts, event.detail) == ("a", 42, None)


def test_keeps_given_ts():
    assert parse_event({"type": "thinking", "agentId": "a", "ts": 5}, now_ms=42).ts == 5


def test_wire_format_is_camel_case_without_nulls():
    event = parse_event({"type": "tool_started", "agent_id": "a", "tool": "Read"}, now_ms=1)
    assert to_wire(event) == {"type": "tool_started", "agentId": "a", "tool": "Read", "ts": 1}


@pytest.mark.parametrize(
    "data",
    [
        "texto",
        {"agentId": "a"},
        {"type": "inexistente", "agentId": "a"},
        {"type": "thinking"},
        {"type": "thinking", "agentId": ""},
        {"type": "thinking", "agentId": "a", "extra": 1},
        {"type": "tool_finished", "agentId": "a", "tool": "Read"},
        {"type": "thinking", "agentId": "a", "ts": -1},
        {"type": "message", "agentId": "a", "text": "x" * 4001},
    ],
)
def test_rejects_invalid_events(data):
    with pytest.raises(ValidationError):
        parse_event(data, now_ms=0)
