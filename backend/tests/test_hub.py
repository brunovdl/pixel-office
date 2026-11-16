import asyncio

import pytest
from pydantic import ValidationError

from pixel_office import hub as hub_module
from pixel_office.hub import Hub


def make_hub() -> Hub:
    ticks = iter(range(1000, 100_000))
    return Hub(clock=lambda: next(ticks))


def join(hub: Hub, agent_id: str = "a") -> None:
    hub.emit("agent_joined", agent_id, name="Agente", role="dev")


def test_emit_updates_state_and_stamps_time():
    hub = make_hub()
    join(hub)
    event = hub.emit("task_started", "a", task="x")
    assert event.ts == 1001
    assert hub.state.agents["a"].status == "thinking"


def test_ingest_rejects_invalid_event_without_changing_state():
    hub = make_hub()
    with pytest.raises(ValidationError):
        hub.ingest({"type": "agent_joined", "agentId": "a"})
    assert hub.state.agents == {}


def test_subscriber_gets_snapshot_then_only_later_events():
    async def scenario():
        hub = make_hub()
        join(hub)
        with hub.subscribe() as subscription:
            assert [a["id"] for a in subscription.snapshot["agents"]] == ["a"]
            assert subscription.queue.empty()
            hub.emit("thinking", "a")
            assert subscription.queue.get_nowait() == {
                "kind": "event",
                "event": {"type": "thinking", "agentId": "a", "ts": 1001},
            }
            assert hub.subscriber_count == 1
        assert hub.subscriber_count == 0

    asyncio.run(scenario())


def test_snapshot_carries_recent_events_up_to_the_limit(monkeypatch):
    async def scenario():
        monkeypatch.setattr(hub_module, "HISTORY_LIMIT", 3)
        hub = make_hub()
        join(hub)
        for _ in range(3):
            hub.emit("thinking", "a")
        with hub.subscribe() as subscription:
            recent = subscription.snapshot["recent"]
        assert [event["type"] for event in recent] == ["thinking"] * 3
        assert [event["ts"] for event in recent] == [1001, 1002, 1003]

    asyncio.run(scenario())


def test_slow_subscriber_is_dropped_and_told(monkeypatch):
    async def scenario():
        monkeypatch.setattr(hub_module, "QUEUE_LIMIT", 3)
        hub = make_hub()
        join(hub)
        with hub.subscribe() as slow, hub.subscribe() as fast:
            for _ in range(4):
                hub.emit("thinking", "a")
                fast.queue.get_nowait()
            assert hub.subscriber_count == 1
            assert slow.queue.get_nowait() is None
            assert slow.queue.empty()

    asyncio.run(scenario())


def test_request_decision_returns_the_answer():
    async def scenario():
        hub = make_hub()
        join(hub)
        request = asyncio.create_task(hub.request_decision("a", "Pode?"))
        await asyncio.sleep(0)
        assert hub.state.agents["a"].question == "Pode?"

        assert hub.answer_decision("a", "Pode") is True
        assert await request == "Pode"
        assert hub.state.agents["a"].status == "thinking"
        assert hub.answer_decision("a", "de novo") is False

    asyncio.run(scenario())


def test_request_decision_times_out_and_releases_the_agent():
    async def scenario():
        hub = make_hub()
        join(hub)
        with hub.subscribe() as subscription:
            assert await hub.request_decision("a", "Pode?", timeout=0.01) is None
            types = []
            while not subscription.queue.empty():
                types.append(subscription.queue.get_nowait()["event"]["type"])
        assert types == ["waiting_decision", "decision_answered"]
        assert hub.state.agents["a"].status == "thinking"

    asyncio.run(scenario())


def test_answer_reaches_agent_whose_waiting_event_came_from_outside():
    hub = make_hub()
    join(hub)
    hub.ingest({"type": "waiting_decision", "agentId": "a", "question": "Pode?"})
    assert hub.answer_decision("a", "sim") is True
    assert hub.state.agents["a"].status == "thinking"


def test_answer_for_unknown_or_busy_agent_is_refused():
    hub = make_hub()
    join(hub)
    assert hub.answer_decision("ninguem", "x") is False
    assert hub.answer_decision("a", "x") is False


def test_cancelled_request_leaves_no_pending_decision():
    async def scenario():
        hub = make_hub()
        join(hub)
        request = asyncio.create_task(hub.request_decision("a", "Pode?"))
        await asyncio.sleep(0)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert hub._decisions == {}

    asyncio.run(scenario())
