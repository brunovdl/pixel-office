"""Time falso que publica eventos no hub, para testar sem provedor de IA."""

import asyncio
import logging
import random
import zlib
from dataclasses import dataclass

from .board import Board, SpecCreate, TaskCreate, TaskUpdate
from .hub import Hub

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Work:
    """Tarefas que o agente simulado inventa e ferramentas que ele usa."""

    tasks: tuple[str, ...]
    # Ferramentas com repetição proporcional à frequência de uso.
    tools: tuple[str, ...]


# Jeito de trabalhar de cada agente padrão; agentes novos usam GENERIC.
WORK: dict[str, Work] = {
    "orq": Work(
        ("Planejar a sprint", "Distribuir tarefas do backlog", "Revisar o andamento"),
        ("Read", "Read", "Grep", "Write"),
    ),
    "spec": Work(
        ("Escrever spec de login", "Detalhar critérios de aceite", "Revisar spec de relatórios"),
        ("Read", "Grep", "Write", "Edit", "Edit"),
    ),
    "be": Work(
        ("Criar endpoint de sessões", "Corrigir validação de entrada", "Adicionar migração"),
        ("Read", "Grep", "Edit", "Edit", "Write", "Bash"),
    ),
    "fe": Work(
        ("Montar tela de cadastro", "Ajustar layout responsivo", "Ligar formulário à API"),
        ("Read", "Glob", "Edit", "Edit", "Write", "Bash"),
    ),
    "qa": Work(
        ("Rodar a suíte de testes", "Escrever teste de regressão", "Validar critérios de aceite"),
        ("Read", "Bash", "Bash", "Bash", "Edit"),
    ),
    "rev": Work(
        ("Revisar PR de sessões", "Revisar PR de cadastro", "Conferir cobertura de testes"),
        ("Read", "Read", "Read", "Grep", "Bash"),
    ),
}
GENERIC = Work(
    ("Investigar um bug", "Atualizar a documentação", "Revisar o backlog"),
    ("Read", "Grep", "Edit", "Bash"),
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

# Tarefas encerradas (concluídas ou bloqueadas) mantidas no quadro simulado.
FINISHED_LIMIT = 40

SEED_SPECS: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    (
        "Login com e-mail e senha",
        "implemented",
        (
            "Usuário entra com e-mail e senha válidos",
            "Senha errada mostra mensagem sem dizer se o e-mail existe",
            "Cinco tentativas erradas bloqueiam por 15 minutos",
            "Sessão expira depois de 30 dias sem uso",
            "Logout encerra a sessão em todos os dispositivos",
        ),
        "## Objetivo\n\nPermitir que o usuário entre com e-mail e senha.\n\n"
        "## Fora do escopo\n\n- Login social\n- Autenticação em dois fatores",
    ),
    (
        "Relatórios mensais por categoria",
        "in_progress",
        (
            "Relatório mostra total gasto por categoria no mês escolhido",
            "Comparação com o mês anterior em percentual",
            "Categorias sem gasto não aparecem",
            "Relatório abre em menos de 2 segundos com 10 mil transações",
        ),
        "## Objetivo\n\nMostrar para onde foi o dinheiro em cada mês.\n\n"
        "## Dados\n\nUsa a tabela `transactions`, agrupada por `category_id`.",
    ),
    (
        "Exportar transações em CSV",
        "draft",
        (
            "Usuário escolhe o período antes de exportar",
            "Arquivo usa ponto e vírgula e codificação UTF-8",
            "Valores negativos saem com sinal de menos",
        ),
        "## Objetivo\n\nLevar as transações para uma planilha.\n\n"
        "## Em aberto\n\n- Incluir transações excluídas?",
    ),
)

# (agente, título, índice da spec, status)
SEED_TASKS: tuple[tuple[str, str, int, str], ...] = (
    ("be", "Criar endpoint de login", 0, "done"),
    ("fe", "Tela de login", 0, "done"),
    ("qa", "Testes de bloqueio por tentativas", 0, "done"),
    ("orq", "Planejar entrega dos relatórios", 1, "pending"),
    ("be", "Endpoint de relatório mensal", 1, "pending"),
    ("fe", "Tela de relatório com gráfico", 1, "pending"),
    ("qa", "Testes do relatório mensal", 1, "pending"),
    ("rev", "Revisar PR do relatório mensal", 1, "pending"),
    ("spec", "Detalhar spec de exportação CSV", 2, "pending"),
)


class Simulator:
    """Faz os agentes ativos da configuração trabalharem com eventos falsos.

    Acompanha a configuração: agente novo começa a trabalhar, agente desativado
    ou excluído para.
    """

    def __init__(self, hub: Hub, *, seed: int = 1, speed: float = 1.0) -> None:
        if speed <= 0:
            raise ValueError("speed deve ser maior que zero")
        self.hub = hub
        self.seed = seed
        self.speed = speed
        self._loops: dict[str, asyncio.Task[None]] = {}

    async def run(self) -> None:
        """Roda até ser cancelado."""
        if self.hub.board.is_empty():
            seed_board(self.hub.board)
        stop = self.hub.config.on_change(self._reconcile)
        try:
            self._reconcile()
            await asyncio.Event().wait()
        finally:
            stop()
            loops = list(self._loops.values())
            self._loops.clear()
            for loop in loops:
                loop.cancel()
            await asyncio.gather(*loops, return_exceptions=True)

    def _reconcile(self) -> None:
        active = [agent["id"] for agent in self.hub.config.agents() if agent["enabled"]]
        for agent_id in list(self._loops):
            if agent_id not in active:
                self._loops.pop(agent_id).cancel()
        for index, agent_id in enumerate(active):
            if agent_id not in self._loops:
                task = asyncio.get_running_loop().create_task(self._agent(agent_id, index))
                self._loops[agent_id] = task

    async def _sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds / self.speed)

    async def _agent(self, agent_id: str, index: int) -> None:
        try:
            await self._work(agent_id, index)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Agente simulado %s parou com erro", agent_id)

    async def _work(self, agent_id: str, index: int) -> None:
        # Gerador próprio, para a sequência do agente não depender dos outros.
        rng = random.Random(self.seed * 31 + zlib.crc32(agent_id.encode()))
        hub = self.hub
        work = WORK.get(agent_id, GENERIC)

        await self._sleep(0.4 + index * 0.7)
        if agent_id not in hub.state.agents:
            # Sem Roster (como nos testes), o próprio simulador põe o agente na sala.
            agent = hub.config.agent(agent_id)
            hub.emit("agent_joined", agent_id, name=agent["name"], role=agent["role"] or "Agente")

        while True:
            await self._sleep(rng.uniform(3, 10))
            task_id, title = self._claim(agent_id, work, rng)
            hub.emit("task_started", agent_id, task=title)
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

                tool = rng.choice(work.tools)
                hub.emit("tool_started", agent_id, tool=tool, detail=_detail(rng, tool))
                await self._sleep(rng.uniform(1.5, 5))
                hub.emit("tool_finished", agent_id, tool=tool, ok=rng.random() < 0.9)
                if rng.random() < 0.3:
                    hub.emit("message", agent_id, text=rng.choice(MESSAGES))
                await self._sleep(rng.uniform(0.8, 2.5))

            if rng.random() < 0.9:
                self._finish(task_id, "done")
                hub.emit("task_finished", agent_id, ok=True)
            else:
                hub.emit("error", agent_id, message="Limite de tentativas atingido")
                await self._sleep(4)
                self._finish(task_id, "blocked")
                hub.emit("task_finished", agent_id, ok=False)
                await self._sleep(3)

    def _claim(self, agent_id: str, work: Work, rng: random.Random) -> tuple[int | None, str]:
        """Pega a tarefa pendente mais antiga do agente, ou cria uma nova."""
        board = self.hub.board
        pending = [
            task
            for task in board.tasks()
            if task["agentId"] == agent_id and task["status"] == "pending"
        ]
        if pending:
            task = board.update_task(pending[0]["id"], TaskUpdate(status="in_progress"))
        else:
            open_specs = [
                spec["id"]
                for spec in board.specs()
                if spec["status"] in ("approved", "in_progress")
            ]
            task = board.create_task(
                TaskCreate(
                    title=rng.choice(work.tasks),
                    status="in_progress",
                    agent_id=agent_id,
                    spec_id=rng.choice(open_specs) if open_specs else None,
                )
            )
        return task["id"], task["title"]

    def _finish(self, task_id: int | None, status: str) -> None:
        board = self.hub.board
        if task_id is None:
            return
        try:
            board.update_task(task_id, TaskUpdate.model_validate({"status": status}))
        except ValueError:
            # O usuário pode ter excluído a tarefa enquanto o agente trabalhava.
            return
        finished = [t for t in board.tasks() if t["status"] in ("done", "blocked")]
        for task in finished[: max(0, len(finished) - FINISHED_LIMIT)]:
            board.delete_task(task["id"])


def seed_board(board: Board) -> None:
    """Specs e tarefas de exemplo para o quadro do time simulado."""
    spec_ids = [
        board.create_spec(
            SpecCreate(title=title, status=status, criteria=list(criteria), body=body)
        )["id"]
        for title, status, criteria, body in SEED_SPECS
    ]
    for agent_id, title, spec_index, status in SEED_TASKS:
        board.create_task(
            TaskCreate.model_validate(
                {
                    "title": title,
                    "status": status,
                    "agentId": agent_id,
                    "specId": spec_ids[spec_index],
                }
            )
        )


def _detail(rng: random.Random, tool: str) -> str:
    if tool == "Bash":
        return rng.choice(COMMANDS)
    if tool in ("Grep", "Glob"):
        return rng.choice(PATTERNS)
    return rng.choice(FILES)
