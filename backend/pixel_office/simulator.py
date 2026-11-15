"""Time falso que publica eventos no hub, para testar sem provedor de IA."""

import asyncio
import random
from dataclasses import dataclass

from .hub import Hub


@dataclass(frozen=True)
class Member:
    id: str
    name: str
    role: str
    tasks: tuple[str, ...]
    # Ferramentas com repetição proporcional à frequência de uso.
    tools: tuple[str, ...]


TEAM: tuple[Member, ...] = (
    Member(
        "orq",
        "Orquestrador",
        "Coordena o time",
        ("Planejar a sprint", "Distribuir tarefas do backlog", "Revisar o andamento"),
        ("Read", "Read", "Grep", "Write"),
    ),
    Member(
        "spec",
        "Especificador",
        "Escreve as specs",
        ("Escrever spec de login", "Detalhar critérios de aceite", "Revisar spec de relatórios"),
        ("Read", "Grep", "Write", "Edit", "Edit"),
    ),
    Member(
        "be",
        "Dev Backend",
        "API e dados",
        ("Criar endpoint de sessões", "Corrigir validação de entrada", "Adicionar migração"),
        ("Read", "Grep", "Edit", "Edit", "Write", "Bash"),
    ),
    Member(
        "fe",
        "Dev Frontend",
        "Telas",
        ("Montar tela de cadastro", "Ajustar layout responsivo", "Ligar formulário à API"),
        ("Read", "Glob", "Edit", "Edit", "Write", "Bash"),
    ),
    Member(
        "qa",
        "QA",
        "Testes",
        ("Rodar a suíte de testes", "Escrever teste de regressão", "Validar critérios de aceite"),
        ("Read", "Bash", "Bash", "Bash", "Edit"),
    ),
    Member(
        "rev",
        "Code Reviewer",
        "Revisão de código",
        ("Revisar PR de sessões", "Revisar PR de cadastro", "Conferir cobertura de testes"),
        ("Read", "Read", "Read", "Grep", "Bash"),
    ),
)

FILES = (
    "src/api/sessions.py",
    "src/api/users.py",
    "src/models/user.py",
    "web/src/pages/Signup.tsx",
    "web/src/components/Form.tsx",
    "tests/test_sessions.py",
    "docs/specs/003-login.md",
    "README.md",
)
COMMANDS = ("pytest -q", "npm test", "npm run typecheck", "git diff --stat", "ruff check .")
PATTERNS = ("def create_", "TODO", "useEffect", "class .*Error")
MESSAGES = (
    "Entendi o problema, vou ajustar.",
    "Os testes passaram.",
    "Achei o ponto que precisa mudar.",
    "Falta cobrir um caso de borda.",
)
QUESTIONS = (
    "Posso apagar a tabela antiga?",
    "Uso sessão por cookie ou por token?",
    "Sigo sem o teste de integração?",
    "Mantenho compatibilidade com a versão anterior?",
)

DECISION_TIMEOUT_S = 60.0


class Simulator:
    def __init__(self, hub: Hub, *, seed: int = 1, speed: float = 1.0) -> None:
        if speed <= 0:
            raise ValueError("speed deve ser maior que zero")
        self.hub = hub
        self.seed = seed
        self.speed = speed

    async def run(self) -> None:
        """Roda até ser cancelado."""
        async with asyncio.TaskGroup() as group:
            for index, member in enumerate(TEAM):
                group.create_task(self._agent(member, index))

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds / self.speed)

    async def _agent(self, member: Member, index: int) -> None:
        # Gerador próprio, para a sequência do agente não depender dos outros.
        rng = random.Random(self.seed * 31 + index)
        hub = self.hub
        agent_id = member.id

        await self._sleep(0.4 + index * 0.7)
        hub.emit("agent_joined", agent_id, name=member.name, role=member.role)

        while True:
            await self._sleep(rng.uniform(3, 10))
            hub.emit("task_started", agent_id, task=rng.choice(member.tasks))
            await self._sleep(rng.uniform(1, 3))

            steps = rng.randint(3, 7)
            decision_at = rng.randrange(steps) if rng.random() < 0.25 else -1

            for step in range(steps):
                if step == decision_at:
                    await hub.request_decision(
                        agent_id,
                        rng.choice(QUESTIONS),
                        timeout=DECISION_TIMEOUT_S / self.speed,
                    )
                    await self._sleep(rng.uniform(0.8, 2))

                tool = rng.choice(member.tools)
                hub.emit("tool_started", agent_id, tool=tool, detail=_detail(rng, tool))
                await self._sleep(rng.uniform(1.5, 5))
                hub.emit("tool_finished", agent_id, tool=tool, ok=rng.random() < 0.9)
                if rng.random() < 0.3:
                    hub.emit("message", agent_id, text=rng.choice(MESSAGES))
                await self._sleep(rng.uniform(0.8, 2.5))

            if rng.random() < 0.9:
                hub.emit("task_finished", agent_id, ok=True)
            else:
                hub.emit("error", agent_id, message="Limite de tentativas atingido")
                await self._sleep(4)
                hub.emit("task_finished", agent_id, ok=False)
                await self._sleep(3)


def _detail(rng: random.Random, tool: str) -> str:
    if tool == "Bash":
        return rng.choice(COMMANDS)
    if tool in ("Grep", "Glob"):
        return rng.choice(PATTERNS)
    return rng.choice(FILES)
