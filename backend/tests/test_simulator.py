import asyncio

import pytest

from pixel_office import simulator as simulator_module
from pixel_office.board import TaskCreate
from pixel_office.hub import Hub
from pixel_office.simulator import TEAM, Simulator


def run_for(seconds: float, *, seed: int = 5, speed: float = 2000.0):
    async def scenario():
        hub = Hub()
        events = []

        async def collect(queue):
            while (message := await queue.get()) is not None:
                if message["kind"] == "event":
                    events.append(message["event"])

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


def test_seeds_an_empty_board_and_moves_tasks(monkeypatch):
    monkeypatch.setattr(simulator_module, "FINISHED_LIMIT", 10_000)
    hub, _ = run_for(0.6)
    specs = hub.board.specs()
    assert [s["status"] for s in specs] == ["implemented", "in_progress", "draft"]
    statuses = {task["status"] for task in hub.board.tasks()}
    assert "done" in statuses
    seeded_pending = [
        t for t in hub.board.tasks() if t["title"] == "Endpoint de relatório mensal"
    ]
    assert seeded_pending and seeded_pending[0]["status"] != "pending"


def test_does_not_seed_a_board_that_has_data(monkeypatch):
    monkeypatch.setattr(simulator_module, "FINISHED_LIMIT", 10_000)
    async def scenario():
        hub = Hub()
        hub.board.create_task(TaskCreate(title="Minha tarefa", agent_id="be"))
        task = asyncio.create_task(Simulator(hub, seed=1, speed=2000).run())
        await asyncio.sleep(0.3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return hub

    hub = asyncio.run(scenario())
    assert hub.board.specs() == []
    mine = hub.board.task(1)
    assert mine["status"] != "pending"


def test_finished_tasks_are_capped(monkeypatch):
    monkeypatch.setattr(simulator_module, "FINISHED_LIMIT", 3)
    hub, _ = run_for(1.0)
    finished = [t for t in hub.board.tasks() if t["status"] in ("done", "blocked")]
    assert len(finished) <= 3
