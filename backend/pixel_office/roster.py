"""Mantém no escritório os agentes ativos da configuração."""

from .hub import Hub


class Roster:
    def __init__(self, hub: Hub) -> None:
        self.hub = hub
        # Só remove quem ele mesmo colocou; agentes vindos de eventos externos ficam.
        self._placed: set[str] = set()
        hub.config.on_change(self.sync)

    def sync(self) -> None:
        state = self.hub.state
        wanted = [agent for agent in self.hub.config.agents() if agent["enabled"]]
        wanted_ids = {agent["id"] for agent in wanted}

        for agent in wanted:
            role = agent["role"] or "Agente"
            current = state.agents.get(agent["id"])
            if current is None or current.name != agent["name"] or current.role != role:
                self.hub.emit("agent_joined", agent["id"], name=agent["name"], role=role)
            self._placed.add(agent["id"])

        for agent_id in sorted(self._placed - wanted_ids):
            if agent_id in state.agents:
                self.hub.emit("agent_left", agent_id)
            self._placed.discard(agent_id)
