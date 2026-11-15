import json
from pathlib import Path

import pytest

from pixel_office.events import parse_event
from pixel_office.state import OfficeState, tool_status

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "shared" / "reducer-cases.json").read_text("utf-8")
)


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_reducer_case(case):
    state = OfficeState()
    for data in case["events"]:
        state.apply(parse_event(data, now_ms=0))

    assert list(state.agents) == case["order"]
    if "nextSeq" in case:
        assert state.next_seq == case["nextSeq"]
    for agent_id, expected in case["agents"].items():
        actual = state.agents[agent_id].to_wire()
        assert {key: actual[key] for key in expected} == expected


def test_tool_status_ignores_case():
    assert tool_status("READ") == "reading"
    assert tool_status("write") == "writing"
    assert tool_status("Bash") == "running"


def test_snapshot_lists_agents_in_join_order():
    state = OfficeState()
    for agent_id in ("b", "a"):
        state.apply(
            parse_event(
                {"type": "agent_joined", "agentId": agent_id, "name": "N", "role": "r"}, now_ms=7
            )
        )
    snapshot = state.snapshot()
    assert [agent["id"] for agent in snapshot["agents"]] == ["b", "a"]
    assert snapshot["nextSeq"] == 2
    assert snapshot["agents"][0] == {
        "id": "b",
        "name": "N",
        "role": "r",
        "seq": 0,
        "status": "idle",
        "detail": "",
        "task": None,
        "question": None,
        "lastEventTs": 7,
    }
