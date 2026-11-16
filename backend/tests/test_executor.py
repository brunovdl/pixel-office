import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from pixel_office.board import SpecCreate, TaskCreate, TaskUpdate
from pixel_office.config import (
    AgentUpdate,
    Config,
    KeyInput,
    McpCreate,
    OfficeSettings,
    RunnerSettings,
)
from pixel_office.executor import Executor
from pixel_office.hub import Hub
from pixel_office.roster import Roster

FAKE = """#!{python}
import json, os, pathlib, sys, time
args = sys.argv[1:]
if args == ["--version"]:
    print("9.9.9 (Claude Code)")
    sys.exit(0)
record = {{"args": args, "env": dict(os.environ), "cwd": os.getcwd(), "stdin": sys.stdin.read()}}
if "--append-system-prompt-file" in args:
    record["system"] = open(args[args.index("--append-system-prompt-file") + 1]).read()
if "--mcp-config" in args:
    path = args[args.index("--mcp-config") + 1]
    record["mcp"] = json.load(open(path))
    record["mcp_mode"] = oct(os.stat(path).st_mode & 0o777)
pathlib.Path({record!r}).write_text(json.dumps(record))
def out(message):
    print(json.dumps(message), flush=True)
cwd = os.getcwd()
out({{"type": "system", "subtype": "init", "session_id": "s1"}})
mode = {mode!r}
if mode == "ok":
    out({{"type": "assistant", "message": {{"content": [
        {{"type": "text", "text": "Vou ler o arquivo."}},
        {{"type": "tool_use", "id": "t1", "name": "Read", "input": {{"file_path": cwd + "/src/app.py"}}}}]}}}})
    out({{"type": "user", "message": {{"content": [{{"type": "tool_result", "tool_use_id": "t1"}}]}}}})
    out({{"type": "result", "subtype": "success", "is_error": False, "result": "Mudei src/app.py e os testes passaram."}})
elif mode == "error":
    out({{"type": "result", "subtype": "error_max_turns", "is_error": True, "result": ""}})
elif mode == "crash":
    print("boom: sem credencial", file=sys.stderr)
    sys.exit(1)
elif mode == "slow":
    out({{"type": "assistant", "message": {{"content": [
        {{"type": "tool_use", "id": "t1", "name": "Bash", "input": {{"command": "sleep 60"}}}}]}}}})
    time.sleep(60)
"""


def fake_claude(tmp_path: Path, mode: str) -> tuple[str, Path]:
    record = tmp_path / f"record-{mode}.json"
    script = tmp_path / f"claude-{mode}"
    script.write_text(FAKE.format(python=sys.executable, record=str(record), mode=mode))
    script.chmod(0o755)
    return str(script), record


def setup(tmp_path: Path, *, workspace: bool = True, credential: bool = True):
    hub = Hub(config=Config(seed_defaults=True))
    Roster(hub).sync()
    config = hub.config
    config.update_agent(
        "be", AgentUpdate(tool="claude_code", model="sonnet", prompt="Cuide da API.")
    )
    if credential:
        config.set_api_key("claude_oauth", KeyInput(value="oauth-token-1234567890"))
    repo = tmp_path / "repo"
    repo.mkdir()
    if workspace:
        config.set_runner(RunnerSettings(workspace_dir=str(repo)))
    config.set_office(OfficeSettings(master_prompt="# Regras do projeto"))
    spec = hub.board.create_spec(
        SpecCreate(title="Login", criteria=["Entra com e-mail"], body="## Objetivo\n\nEntrar.")
    )
    task = hub.board.create_task(
        TaskCreate(
            title="Criar endpoint", description="Detalhes", agent_id="be", spec_id=spec["id"]
        )
    )
    return hub, task["id"], repo


async def wait_for(condition, seconds: float = 10.0) -> None:
    for _ in range(int(seconds / 0.02)):
        if condition():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condição não aconteceu")


def run_executor(hub, binary, tmp_path, until, *, before=None, minute=60.0):
    async def scenario():
        executor = Executor(
            hub, data_dir=tmp_path / "data", claude_bin=binary, poll_seconds=0.05, minute=minute
        )
        events = []
        with hub.subscribe() as subscription:
            task = asyncio.create_task(executor.run())
            try:
                if before:
                    await before(executor)
                await wait_for(lambda: until(hub))
                await asyncio.sleep(0.1)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            while not subscription.queue.empty():
                message = subscription.queue.get_nowait()
                if message and message["kind"] == "event":
                    events.append(message["event"])
        return executor, events

    return asyncio.run(scenario())


def status(hub, task_id):
    return hub.board.task(task_id)["status"]


def test_runs_task_and_sends_it_to_review(tmp_path, monkeypatch):
    monkeypatch.setenv("PIXEL_OFFICE_TOKEN", "segredo-do-harness")
    hub, task_id, repo = setup(tmp_path)
    hub.config.create_mcp(
        McpCreate(id="gh", name="GitHub", command="npx", args=["-y", "gh"], env={"TOKEN": "ghp_x"})
    )
    hub.config.update_agent("be", AgentUpdate(mcps=["gh"]))
    binary, record = fake_claude(tmp_path, "ok")

    _, events = run_executor(hub, binary, tmp_path, lambda h: status(h, task_id) == "review")

    task = hub.board.task(task_id)
    assert "## Resultado (Claude Code" in task["description"]
    assert "Mudei src/app.py" in task["description"]

    mine = [(e["type"], e.get("tool"), e.get("detail")) for e in events if e["agentId"] == "be"]
    assert mine[0] == ("task_started", None, None)
    assert ("tool_started", "Read", "src/app.py") in mine
    assert ("tool_finished", "Read", None) in mine
    assert mine[-1] == ("task_finished", None, None)
    assert hub.state.agents["be"].status == "done"

    seen = json.loads(record.read_text())
    assert seen["cwd"] == str(repo)
    assert seen["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "oauth-token-1234567890"
    assert "PIXEL_OFFICE_TOKEN" not in seen["env"]
    assert seen["env"]["HOME"].endswith("homes/claude_code")
    args = seen["args"]
    assert args[args.index("--permission-mode") + 1] == "acceptEdits"
    assert args[args.index("--model") + 1] == "sonnet"
    assert args[args.index("--output-format") + 1] == "stream-json"
    assert "--strict-mcp-config" in args
    assert seen["mcp"] == {
        "mcpServers": {
            "gh": {
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "gh"],
                "env": {"TOKEN": "ghp_x"},
            }
        }
    }
    assert seen["mcp_mode"] == "0o600"
    assert "# Tarefa T-001: Criar endpoint" in seen["stdin"]
    assert "CA-1: Entra com e-mail" in seen["stdin"]
    assert "# Regras do projeto" in seen["system"]
    assert "Cuide da API." in seen["system"]
    assert not list((tmp_path / "data" / "run").iterdir())


def test_failed_run_blocks_the_task(tmp_path):
    hub, task_id, _ = setup(tmp_path)
    binary, _ = fake_claude(tmp_path, "error")
    _, events = run_executor(hub, binary, tmp_path, lambda h: status(h, task_id) == "blocked")
    assert "## Falha (Claude Code" in hub.board.task(task_id)["description"]
    assert any(e["type"] == "error" and "error_max_turns" in e["message"] for e in events)


def test_crash_without_result_reports_stderr(tmp_path):
    hub, task_id, _ = setup(tmp_path)
    binary, _ = fake_claude(tmp_path, "crash")
    run_executor(hub, binary, tmp_path, lambda h: status(h, task_id) == "blocked")
    description = hub.board.task(task_id)["description"]
    assert "saiu com código 1" in description
    assert "boom: sem credencial" in description


def test_missing_setup_is_reported_once_and_task_waits(tmp_path):
    hub, task_id, repo = setup(tmp_path, workspace=False, credential=False)
    binary, _ = fake_claude(tmp_path, "ok")

    async def fix_later(executor):
        await wait_for(
            lambda: any(
                e for e in hub.state.agents.values() if e.id == "be" and e.status == "error"
            )
        )
        assert status(hub, task_id) == "pending"
        hub.config.set_runner(RunnerSettings(workspace_dir=str(repo)))
        await asyncio.sleep(0.2)
        assert status(hub, task_id) == "pending"
        hub.config.set_api_key("anthropic", KeyInput(value="sk-ant-123456789012"))

    _, events = run_executor(
        hub, binary, tmp_path, lambda h: status(h, task_id) == "review", before=fix_later
    )
    problems = [e["message"] for e in events if e["type"] == "error"]
    assert problems == [
        "Defina a pasta do projeto em Configurações > Execução.",
        "Cadastre a credencial do Claude Code em Configurações > Credenciais.",
    ]


def test_reports_when_claude_is_not_installed(tmp_path):
    hub, task_id, _ = setup(tmp_path)
    executor, _ = run_executor(
        hub,
        "comando-que-nao-existe",
        tmp_path,
        lambda h: h.state.agents["be"].status == "error",
    )
    assert "não está instalado" in hub.state.agents["be"].detail
    assert status(hub, task_id) == "pending"
    assert executor.status()["tools"]["claude_code"]["installed"] is False


def test_moving_the_task_stops_the_run(tmp_path):
    hub, task_id, _ = setup(tmp_path)
    binary, _ = fake_claude(tmp_path, "slow")

    async def stop_it(executor):
        await wait_for(lambda: hub.state.agents["be"].status == "running")
        hub.board.update_task(
            task_id, TaskUpdate.model_validate({"status": "pending", "agentId": None})
        )

    executor, events = run_executor(
        hub, binary, tmp_path, lambda h: h.state.agents["be"].status == "error", before=stop_it
    )
    assert status(hub, task_id) == "pending"
    assert "Resultado" not in hub.board.task(task_id)["description"]
    assert any(e["type"] == "message" and e["text"] == "Execução interrompida." for e in events)
    assert executor.status()["running"] == []


def test_timeout_blocks_the_task(tmp_path):
    hub, task_id, _ = setup(tmp_path)
    hub.config.set_runner(
        RunnerSettings(workspace_dir=hub.config.runner()["workspaceDir"], timeout_minutes=1)
    )
    binary, _ = fake_claude(tmp_path, "slow")
    run_executor(hub, binary, tmp_path, lambda h: status(h, task_id) == "blocked", minute=0.5)
    assert "tempo limite de 1 min" in hub.board.task(task_id)["description"]


def test_ignores_agents_without_claude_code(tmp_path):
    hub, task_id, _ = setup(tmp_path)
    hub.config.update_agent("be", AgentUpdate.model_validate({"tool": None}))
    binary, record = fake_claude(tmp_path, "ok")

    async def wait_a_bit(executor):
        await asyncio.sleep(0.3)

    run_executor(hub, binary, tmp_path, lambda h: True, before=wait_a_bit)
    assert status(hub, task_id) == "pending"
    assert not record.exists()


@pytest.mark.parametrize(
    "bad", [{"timeoutMinutes": 0}, {"maxParallel": 9}, {"permissionMode": "tudo"}]
)
def test_runner_settings_validation(bad):
    with pytest.raises(ValueError):
        RunnerSettings.model_validate(bad)


def test_status_describes_workspace(tmp_path):
    hub, _, repo = setup(tmp_path)
    (repo / ".git").mkdir()
    executor = Executor(hub, data_dir=tmp_path / "data")
    assert executor.status()["workspace"] == {"path": str(repo), "exists": True, "git": True}
    assert os.path.isdir(repo)
