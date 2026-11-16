from pixel_office.config import AgentCreate, AgentUpdate, Config
from pixel_office.hub import Hub
from pixel_office.roster import Roster


def test_places_enabled_agents_and_follows_changes():
    hub = Hub(config=Config(seed_defaults=True))
    Roster(hub).sync()
    assert list(hub.state.agents) == ["orq", "spec", "be", "fe", "qa", "rev"]

    hub.config.update_agent("qa", AgentUpdate(enabled=False))
    assert "qa" not in hub.state.agents

    hub.config.update_agent("be", AgentUpdate(name="Backend Python"))
    assert hub.state.agents["be"].name == "Backend Python"

    hub.config.create_agent(AgentCreate(id="dados", name="Especialista de Dados"))
    assert hub.state.agents["dados"].role == "Agente"

    hub.config.delete_agent("dados")
    assert "dados" not in hub.state.agents


def test_keeps_agents_that_came_from_outside():
    hub = Hub(config=Config())
    hub.emit("agent_joined", "externo", name="Externo", role="x")
    roster = Roster(hub)
    roster.sync()
    hub.config.create_agent(AgentCreate(id="a", name="A"))
    hub.config.delete_agent("a")
    assert list(hub.state.agents) == ["externo"]


def test_does_not_emit_when_nothing_changed():
    hub = Hub(config=Config(seed_defaults=True))
    roster = Roster(hub)
    roster.sync()
    with hub.subscribe() as subscription:
        roster.sync()
        assert subscription.queue.empty()
