"""Executor no servidor: roda o Claude Code nas tarefas dos agentes.

Pega a tarefa pendente mais antiga de cada agente ativo cuja ferramenta é o
Claude Code, roda `claude -p` na pasta do projeto com a credencial, o prompt e os
MCPs do agente, e publica cada passo como evento. No fim, a tarefa vai para
revisão com o resumo do agente, ou fica bloqueada com o motivo.
"""

import asyncio
import contextlib
import json
import logging
import os
import shutil
import signal
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .board import TaskUpdate
from .claude_code import TEXT_LIMIT, ClaudeCodeTranslator, clip
from .hub import Hub

log = logging.getLogger(__name__)

TOOL = "claude_code"
DESCRIPTION_LIMIT = 20_000
# Variáveis do servidor que a ferramenta precisa para sair pela rede.
PASSTHROUGH_ENV = (
    "PATH",
    "LANG",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
)
CREDENTIAL_ORDER = ("claude_oauth", "anthropic")
CREDENTIAL_ENV = {"claude_oauth": "CLAUDE_CODE_OAUTH_TOKEN", "anthropic": "ANTHROPIC_API_KEY"}
UNATTENDED = (
    "Você trabalha sem ninguém para responder perguntas durante a execução. Se faltar uma "
    "decisão, escolha a opção mais segura, registre a dúvida no resumo final e siga."
)
FINAL_REQUEST = (
    "Ao terminar, responda com um resumo curto: o que mudou, os arquivos tocados, como "
    "testou e o que ficou pendente."
)


@dataclass
class Job:
    agent_id: str
    task_id: int
    task: asyncio.Task[None] | None = None
    process: asyncio.subprocess.Process | None = None
    stopped_by_user: bool = False
    stderr: list[str] = field(default_factory=list)


class Executor:
    def __init__(
        self,
        hub: Hub,
        *,
        data_dir: Path,
        claude_bin: str = "claude",
        poll_seconds: float = 3.0,
        minute: float = 60.0,
    ) -> None:
        self.hub = hub
        self.data_dir = data_dir
        self.claude_bin = claude_bin
        self.poll_seconds = poll_seconds
        # Segundos por minuto do tempo limite; os testes encurtam.
        self.minute = minute
        self.claude_version: str | None = None
        self._jobs: dict[str, Job] = {}
        self._reported: set[tuple[int, str]] = set()
        self._wake = asyncio.Event()

    # ------------------------------------------------------------ situação

    def status(self) -> dict[str, Any]:
        settings = self.hub.config.runner()
        workspace = settings["workspaceDir"]
        exists = bool(workspace) and Path(workspace).is_dir()
        return {
            "tools": {
                TOOL: {
                    "installed": self.claude_version is not None,
                    "version": self.claude_version,
                    "command": self.claude_bin,
                }
            },
            "workspace": {
                "path": workspace,
                "exists": exists,
                "git": exists and (Path(workspace) / ".git").exists(),
            },
            "running": [
                {"agentId": job.agent_id, "taskId": job.task_id} for job in self._jobs.values()
            ],
        }

    async def detect(self) -> None:
        """Descobre se o Claude Code está instalado e qual a versão."""
        path = shutil.which(self.claude_bin)
        if path is None:
            self.claude_version = None
            return
        try:
            process = await asyncio.create_subprocess_exec(
                path,
                "--version",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(process.communicate(), timeout=15)
            self.claude_version = out.decode(errors="replace").strip() or "desconhecida"
        except (OSError, TimeoutError):
            self.claude_version = None

    # ------------------------------------------------------------ ciclo

    async def run(self) -> None:
        """Roda até ser cancelado."""
        await self.detect()
        stops = [
            self.hub.board.on_change(self._changed),
            self.hub.config.on_change(self._changed),
        ]
        try:
            while True:
                self._schedule()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), self.poll_seconds)
                self._wake.clear()
        finally:
            for stop in stops:
                stop()
            jobs = list(self._jobs.values())
            for job in jobs:
                if job.task:
                    job.task.cancel()
            await asyncio.gather(*(job.task for job in jobs if job.task), return_exceptions=True)

    def _changed(self) -> None:
        self._stop_orphans()
        self._wake.set()

    def _stop_orphans(self) -> None:
        """Para quem perdeu a tarefa: movida pelo usuário, excluída ou agente trocado."""
        tasks = {task["id"]: task for task in self.hub.board.tasks()}
        agents = {agent["id"]: agent for agent in self.hub.config.agents()}
        for job in list(self._jobs.values()):
            task = tasks.get(job.task_id)
            agent = agents.get(job.agent_id)
            lost = task is None or task["status"] != "in_progress"
            gone = agent is None or not agent["enabled"] or agent["tool"] != TOOL
            if (lost or gone) and job.task and not job.stopped_by_user:
                job.stopped_by_user = True
                job.task.cancel()

    def _schedule(self) -> None:
        config = self.hub.config
        settings = config.runner()
        agents = [a for a in config.agents() if a["enabled"] and a["tool"] == TOOL]
        if not agents:
            return
        pending: dict[str, list[dict[str, Any]]] = {}
        for task in self.hub.board.tasks():
            if task["status"] == "pending" and task["agentId"]:
                pending.setdefault(task["agentId"], []).append(task)

        for agent in agents:
            if len(self._jobs) >= settings["maxParallel"]:
                return
            if agent["id"] in self._jobs or not pending.get(agent["id"]):
                continue
            task = pending[agent["id"]][0]
            problem = self._problem(settings)
            if problem:
                self._report(agent["id"], task["id"], problem)
                continue
            job = Job(agent_id=agent["id"], task_id=task["id"])
            self._jobs[agent["id"]] = job
            job.task = asyncio.get_running_loop().create_task(self._run_job(job, agent, task))

    def _problem(self, settings: dict[str, Any]) -> str | None:
        if self.claude_version is None:
            return f"O Claude Code não está instalado no servidor (comando {self.claude_bin})."
        workspace = settings["workspaceDir"]
        if not workspace:
            return "Defina a pasta do projeto em Configurações > Execução."
        if not Path(workspace).is_dir():
            return f"A pasta do projeto não existe: {workspace}"
        if not any(self.hub.config.api_key(c) for c in CREDENTIAL_ORDER):
            return "Cadastre a credencial do Claude Code em Configurações > Credenciais."
        return None

    def _report(self, agent_id: str, task_id: int, problem: str) -> None:
        """Avisa uma vez por tarefa e motivo; a tarefa fica pendente até resolver."""
        if (task_id, problem) in self._reported:
            return
        self._reported.add((task_id, problem))
        if agent_id in self.hub.state.agents:
            self.hub.emit("error", agent_id, message=clip(problem, TEXT_LIMIT))

    # ------------------------------------------------------------ execução

    async def _run_job(self, job: Job, agent: dict[str, Any], task: dict[str, Any]) -> None:
        hub = self.hub
        board = hub.board
        settings = hub.config.runner()
        workspace = settings["workspaceDir"]
        emitted = False

        def emit(kind: str, **fields: Any) -> None:
            if agent["id"] in hub.state.agents:
                hub.emit(kind, agent["id"], **fields)

        try:
            board.update_task(task["id"], TaskUpdate(status="in_progress"))
            emit("task_started", task=clip(task["title"], TEXT_LIMIT))
            emitted = True
            translator = ClaudeCodeTranslator(emit, workspace)
            with tempfile.TemporaryDirectory(dir=self._run_dir()) as scratch:
                args, env, stdin = self._command(agent, task, settings, Path(scratch))
                ok, summary = await self._execute(
                    job, args, env, stdin, workspace, translator, settings["timeoutMinutes"]
                )
            self._finish(job, task, ok, summary, emit)
        except asyncio.CancelledError:
            if emitted:
                emit("message", text="Execução interrompida.")
                emit("task_finished", ok=False)
            if not job.stopped_by_user:
                raise
        except Exception as exc:  # erro do próprio harness, não do agente
            log.exception("Falha ao executar a tarefa %s", task["id"])
            with contextlib.suppress(Exception):
                self._finish(job, task, False, f"Erro no harness: {exc}", emit)
        finally:
            self._jobs.pop(job.agent_id, None)
            self._wake.set()

    def _run_dir(self) -> Path:
        path = self.data_dir / "run"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _command(
        self, agent: dict[str, Any], task: dict[str, Any], settings: dict[str, Any], scratch: Path
    ) -> tuple[list[str], dict[str, str], bytes]:
        config = self.hub.config
        system_file = scratch / "system.md"
        system_file.write_text(self._system_prompt(agent), "utf-8")
        args = [
            shutil.which(self.claude_bin) or self.claude_bin,
            "-p",
            "Execute a tarefa descrita na entrada.",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            settings["permissionMode"],
            "--append-system-prompt-file",
            str(system_file),
            "--no-session-persistence",
            "--strict-mcp-config",
        ]
        if agent["model"]:
            args += ["--model", agent["model"]]
        if settings["maxTurns"]:
            args += ["--max-turns", str(settings["maxTurns"])]

        servers = {}
        for mcp_id in agent["mcps"]:
            mcp = config.mcp_runtime(mcp_id)
            if not mcp["enabled"]:
                continue
            if mcp["transport"] == "stdio":
                servers[mcp_id] = {
                    "type": "stdio",
                    "command": mcp["command"],
                    "args": mcp["args"],
                    "env": mcp["env"],
                }
            else:
                servers[mcp_id] = {"type": "http", "url": mcp["url"], "headers": mcp["headers"]}
        if servers:
            mcp_file = scratch / "mcp.json"
            fd = os.open(mcp_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"mcpServers": servers}, handle)
            args += ["--mcp-config", str(mcp_file)]

        home = self.data_dir / "homes" / TOOL
        home.mkdir(parents=True, exist_ok=True)
        # Ambiente mínimo: o agente não herda o token do harness nem outros segredos.
        env = {name: os.environ[name] for name in PASSTHROUGH_ENV if name in os.environ}
        env.update({"HOME": str(home), "TERM": "dumb", "NO_COLOR": "1"})
        env.setdefault("LANG", "C.UTF-8")
        for credential in CREDENTIAL_ORDER:
            value = config.api_key(credential)
            if value:
                env[CREDENTIAL_ENV[credential]] = value
                break
        return args, env, self._task_prompt(task).encode()

    def _system_prompt(self, agent: dict[str, Any]) -> str:
        office = self.hub.config.office()
        parts = []
        if office["masterPrompt"].strip():
            parts.append(office["masterPrompt"].strip())
        role = f"# Seu papel: {agent['name']}"
        if agent["role"]:
            role += f"\n\n{agent['role']}"
        if agent["prompt"].strip():
            role += f"\n\n{agent['prompt'].strip()}"
        parts += [role, UNATTENDED]
        return "\n\n".join(parts)

    def _task_prompt(self, task: dict[str, Any]) -> str:
        code = f"T-{task['id']:03d}"
        parts = [f"# Tarefa {code}: {task['title']}"]
        if task["description"].strip():
            parts.append(task["description"].strip())
        if task["specId"] is not None:
            with contextlib.suppress(ValueError):
                spec = self.hub.board.spec(task["specId"])
                section = [f"# Spec {spec['id']:03d}: {spec['title']}"]
                if spec["criteria"]:
                    section.append("## Critérios de aceite")
                    section += [f"- CA-{i}: {c}" for i, c in enumerate(spec["criteria"], 1)]
                if spec["body"].strip():
                    section.append(spec["body"].strip())
                parts.append("\n\n".join(section))
        parts.append(FINAL_REQUEST)
        return "\n\n".join(parts)

    async def _execute(
        self,
        job: Job,
        args: list[str],
        env: dict[str, str],
        stdin: bytes,
        cwd: str,
        translator: ClaudeCodeTranslator,
        timeout_minutes: int,
    ) -> tuple[bool, str]:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
            start_new_session=True,
        )
        job.process = process
        stderr_task = asyncio.create_task(self._drain_stderr(process, job))
        try:
            assert process.stdin and process.stdout
            process.stdin.write(stdin)
            await process.stdin.drain()
            process.stdin.close()
            async with asyncio.timeout(timeout_minutes * self.minute):
                async for raw in process.stdout:
                    line = raw.decode(errors="replace").strip()
                    if not line:
                        continue
                    try:
                        translator.feed(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                await process.wait()
        except TimeoutError:
            await self._terminate(process)
            translator.close()
            return False, f"Passou do tempo limite de {timeout_minutes} min."
        except BaseException:
            await self._terminate(process)
            translator.close()
            raise
        finally:
            await asyncio.gather(stderr_task, return_exceptions=True)

        translator.close()
        result = translator.result
        if result is not None:
            text = str(result.get("result") or "").strip()
            failed = bool(result.get("is_error")) or result.get("subtype") != "success"
            if not failed and process.returncode == 0:
                return True, text or "Concluído sem resumo."
            reason = text or str(result.get("subtype") or "erro")
            return False, f"O Claude Code terminou com erro: {reason}"
        tail = "".join(job.stderr)[-1500:].strip()
        return False, (
            f"O Claude Code saiu com código {process.returncode} sem resultado."
            + (f"\n\n{tail}" if tail else "")
        )

    async def _drain_stderr(self, process: asyncio.subprocess.Process, job: Job) -> None:
        assert process.stderr
        async for raw in process.stderr:
            job.stderr.append(raw.decode(errors="replace"))
            if len(job.stderr) > 200:
                del job.stderr[:100]

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        """SIGINT encerra o turno; se não sair, SIGTERM e por fim SIGKILL no grupo."""
        if process.returncode is not None:
            return
        for sig, wait in ((signal.SIGINT, 5), (signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, sig)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), wait)
                return

    def _finish(self, job: Job, task: dict[str, Any], ok: bool, summary: str, emit: Any) -> None:
        board = self.hub.board
        try:
            current = board.task(task["id"])
        except ValueError:
            current = None
        if current is not None and current["status"] == "in_progress":
            stamp = time.strftime("%d/%m %H:%M")
            title = "Resultado" if ok else "Falha"
            header = f"\n\n## {title} (Claude Code, {stamp})\n\n"
            room = DESCRIPTION_LIMIT - len(current["description"]) - len(header)
            update: dict[str, Any] = {"status": "review" if ok else "blocked"}
            if room > 200:
                update["description"] = current["description"] + header + clip(summary, room)
            board.update_task(task["id"], TaskUpdate.model_validate(update))
        if ok:
            emit("message", text=clip(summary, TEXT_LIMIT))
        else:
            emit("error", message=clip(summary, TEXT_LIMIT))
        emit("task_finished", ok=ok)
