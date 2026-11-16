import json
import sqlite3

import pytest
from pydantic import ValidationError

from pixel_office.board import BoardError, NotFound
from pixel_office.config import (
    DEFAULT_AGENTS,
    AgentCreate,
    AgentUpdate,
    Config,
    KeyInput,
    McpCreate,
    McpUpdate,
    OfficeSettings,
    hint,
    sniff_image,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture
def config():
    config = Config()
    yield config
    config.close()


def mcp(**fields) -> McpCreate:
    return McpCreate.model_validate({"id": "github", "name": "GitHub", "command": "npx", **fields})


def test_defaults_without_seed(config):
    office = config.office()
    assert office["name"] == "Pixel Office"
    assert office["promptFiles"] == ["CLAUDE.md", "AGENTS.md"]
    assert office["logo"] is None
    assert config.agents() == []
    assert all(not p["configured"] for p in config.providers())


def test_seed_creates_default_team_once(tmp_path):
    path = tmp_path / "office.db"
    first = Config(path, seed_defaults=True)
    assert [a["id"] for a in first.agents()] == [a[0] for a in DEFAULT_AGENTS]
    for agent_id, *_ in DEFAULT_AGENTS:
        first.delete_agent(agent_id)
    first.close()

    second = Config(path, seed_defaults=True)
    assert second.agents() == []
    second.close()


def test_office_settings(config):
    saved = config.set_office(
        OfficeSettings.model_validate(
            {
                "name": " MAI Martins ",
                "masterPrompt": "# Regras",
                "promptFiles": ["GEMINI.md", "CLAUDE.md", "CLAUDE.md"],
            }
        )
    )
    assert saved["name"] == "MAI Martins"
    assert saved["masterPrompt"] == "# Regras"
    assert saved["promptFiles"] == ["CLAUDE.md", "GEMINI.md"]
    with pytest.raises(ValidationError):
        OfficeSettings.model_validate({"promptFiles": ["README.md"]})


def test_logo_accepts_images_and_rejects_the_rest(config):
    office = config.set_logo(PNG)
    assert office["logo"]["mime"] == "image/png"
    assert config.logo() == ("image/png", PNG)

    for bad in (b"<svg onload=alert(1)>", b"GIF8", b"texto"):
        with pytest.raises(BoardError, match="PNG, JPEG, WEBP ou GIF"):
            config.set_logo(bad)
    with pytest.raises(BoardError, match="2 MB"):
        config.set_logo(PNG + b"\x00" * (2 * 1024 * 1024))

    config.delete_logo()
    assert config.logo() is None


@pytest.mark.parametrize(
    ("data", "mime"),
    [
        (b"\xff\xd8\xff\xe0rest", "image/jpeg"),
        (b"GIF89a....", "image/gif"),
        (b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp"),
        (b"<?xml", None),
    ],
)
def test_sniff_image(data, mime):
    assert sniff_image(data) == mime


def test_api_keys_are_encrypted_and_never_public(tmp_path):
    path = tmp_path / "office.db"
    config = Config(path)
    secret = "gsk_live_1234567890abcdef"
    config.set_api_key("groq", KeyInput(value=f"  {secret}  "))

    groq = next(p for p in config.providers() if p["id"] == "groq")
    assert groq["configured"] and groq["hint"] == "…cdef"
    assert secret not in json.dumps(config.public())
    assert config.api_key("groq") == secret
    config.close()

    raw = sqlite3.connect(path).execute("SELECT value_enc FROM api_keys").fetchone()[0]
    assert secret not in raw
    assert (tmp_path / "secret.key").stat().st_mode & 0o777 == 0o600

    reopened = Config(path)
    assert reopened.api_key("groq") == secret
    reopened.delete_api_key("groq")
    assert reopened.api_key("groq") is None
    reopened.close()


def test_unknown_provider(config):
    with pytest.raises(NotFound):
        config.set_api_key("outro", KeyInput(value="x"))


def test_short_secrets_show_no_hint():
    assert hint("curto") == "…"
    assert hint("123456789012") == "…9012"


def test_mcp_secrets_are_masked_and_can_be_kept(config):
    created = config.create_mcp(
        mcp(args=["-y", "server"], env={"GITHUB_TOKEN": "ghp_abcdefghijklmnop"})
    )
    assert created["env"] == [{"name": "GITHUB_TOKEN", "hint": "…mnop"}]
    assert "ghp_" not in json.dumps(config.public())

    config.update_mcp(
        "github",
        McpUpdate.model_validate({"env": {"GITHUB_TOKEN": None, "LOG_LEVEL": "debug-verbose"}}),
    )
    runtime = config.mcp_runtime("github")
    assert runtime["env"] == {"GITHUB_TOKEN": "ghp_abcdefghijklmnop", "LOG_LEVEL": "debug-verbose"}
    assert runtime["args"] == ["-y", "server"]

    config.update_mcp("github", McpUpdate.model_validate({"env": {"LOG_LEVEL": None}}))
    assert config.mcp_runtime("github")["env"] == {"LOG_LEVEL": "debug-verbose"}

    with pytest.raises(BoardError, match="Informe o valor de NOVO"):
        config.update_mcp("github", McpUpdate.model_validate({"env": {"NOVO": None}}))


def test_mcp_shape_is_checked(config):
    with pytest.raises(BoardError, match="comando"):
        config.create_mcp(mcp(command=""))
    with pytest.raises(BoardError, match="URL"):
        config.create_mcp(mcp(transport="http", url="ftp://x"))
    created = config.create_mcp(mcp(transport="http", url="https://mcp.exemplo.com", command=""))
    assert created["transport"] == "http"
    with pytest.raises(BoardError, match="comando"):
        config.update_mcp("github", McpUpdate.model_validate({"transport": "stdio"}))
    with pytest.raises(BoardError, match="Já existe"):
        config.create_mcp(mcp())


@pytest.mark.parametrize("bad_id", ["", "GitHub", "com espaço", "-x", "a" * 33])
def test_ids_must_be_slugs(bad_id):
    with pytest.raises(ValidationError):
        mcp(id=bad_id)
    with pytest.raises(ValidationError):
        AgentCreate.model_validate({"id": bad_id, "name": "X"})


def test_agent_crud_and_mcp_links(config):
    config.create_mcp(mcp())
    created = config.create_agent(
        AgentCreate.model_validate(
            {
                "id": "dados",
                "name": "Dados",
                "provider": "groq",
                "model": "m",
                "mcps": ["github", "github"],
            }
        )
    )
    assert created["mcps"] == ["github"]
    assert created["enabled"] is True

    with pytest.raises(BoardError, match="MCP não existe: slack"):
        config.update_agent("dados", AgentUpdate.model_validate({"mcps": ["slack"]}))

    updated = config.update_agent(
        "dados",
        AgentUpdate.model_validate({"provider": None, "prompt": "Analise dados", "enabled": False}),
    )
    assert (updated["provider"], updated["prompt"], updated["enabled"]) == (
        None,
        "Analise dados",
        False,
    )

    config.delete_mcp("github")
    assert config.agent("dados")["mcps"] == []

    with pytest.raises(BoardError, match="Já existe"):
        config.create_agent(AgentCreate(id="dados", name="Outro"))
    config.delete_agent("dados")
    with pytest.raises(NotFound):
        config.agent("dados")


def test_update_rejects_null_for_required_fields():
    with pytest.raises(ValidationError):
        AgentUpdate.model_validate({"name": None})
    with pytest.raises(ValidationError):
        McpUpdate.model_validate({"enabled": None})


def test_changes_notify_listeners(config):
    calls = []
    config.on_change(lambda: calls.append(1))
    config.set_office(OfficeSettings())
    config.set_logo(PNG)
    config.set_api_key("openai", KeyInput(value="sk-123"))
    config.create_mcp(mcp())
    config.create_agent(AgentCreate(id="x", name="X"))
    assert len(calls) == 5


def test_wrong_key_file_is_reported(tmp_path):
    path = tmp_path / "office.db"
    config = Config(path)
    config.set_api_key("groq", KeyInput(value="segredo-123456"))
    config.close()
    (tmp_path / "secret.key").unlink()
    with pytest.raises(BoardError, match="secret.key"):
        Config(path).api_key("groq")
