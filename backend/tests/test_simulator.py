import asyncio

import pytest

from pixel_office.hub import Hub
from pixel_office.simulator import TEAM, Simulator


def run_for(seconds: float, *, seed: int = 5, speed: float = 2000.0):
    async def scenario():
        hub = Hub()
        events = []

        async def collect(queue):
            while (event := await queue.get()) is not None:
                events.append(event)

        with hub.subscribe() as subscription:
            collector = asyncio.create_task(collect(subscription.queue))
            simulator = asyncio.create_task(Simulator(hub, seed=seed, speed=speed).run())
            await asyncio.sleep(seconds)
            for task in (simulator, collector):
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
        return hub, events

    return asyncio.run(scenario())


def test_whole_team_joins_and_works():
    hub, events = run_for(0.5)
    assert set(hub.state.agents) == {member.id for member in TEAM}
    types = {event["type"] for event in events}
    assert {"agent_joined", "task_started", "tool_started", "tool_finished"} <= types
    assert "task_finished" in types


def test_each_agent_finishes_a_tool_before_starting_another():
    _, events = run_for(0.5)
    open_tool: dict[str, str | None] = {}
    for event in events:
        agent_id = event["agentId"]
        if event["type"] == "tool_started":
            assert open_tool.get(agent_id) is None
            open_tool[agent_id] = event["tool"]
        elif event["type"] == "tool_finished":
            assert open_tool.get(agent_id) == event["tool"]
            open_tool[agent_id] = None


def test_unanswered_decisions_resolve_by_timeout():
    _, events = run_for(1.0)
    asked = [event for event in events if event["type"] == "waiting_decision"]
    answered = [event for event in events if event["type"] == "decision_answered"]
    assert asked
    assert len(asked) - len(answered) <= len(TEAM)
    assert answered


def test_rejects_non_positive_speed():
    with pytest.raises(ValueError):
        Simulator(Hub(), speed=0)
