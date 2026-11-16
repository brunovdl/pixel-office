"""Configuração do escritório: identidade, logo, chaves de API, MCPs e agentes.

Chaves de API e valores de variáveis e cabeçalhos dos MCPs são segredos: ficam
criptografados no banco e nunca saem pela API pública, que mostra só os quatro
últimos caracteres.
"""

import json
import os
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from cryptography.fernet import Fernet, InvalidToken
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from .board import BoardError, NotFound

PROVIDERS: dict[str, str] = {
    "anthropic": "Anthropic (API)",
    "claude_oauth": "Claude Code (token OAuth)",
    "groq": "Groq",
    "openai": "OpenAI",
    "google": "Google Gemini",
}
PROMPT_FILES = ("CLAUDE.md", "AGENTS.md", "GEMINI.md")
LOGO_MAX_BYTES = 2 * 1024 * 1024

Provider = Literal["anthropic", "claude_oauth", "groq", "openai", "google"]
PromptFile = Literal["CLAUDE.md", "AGENTS.md", "GEMINI.md"]
Slug = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,31}$")]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Role = Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)]
Prompt = Annotated[str, Field(max_length=100_000)]
SecretName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")]
SecretValue = Annotated[str, Field(min_length=1, max_length=8000)]
# Valor null num mapa de segredos = manter o valor já guardado.
SecretMap = Annotated[dict[SecretName, SecretValue | None], Field(max_length=50)]

DEFAULT_MASTER_PROMPT = """# Instruções do projeto

Este repositório é desenvolvido por um time de agentes no Pixel Office.

- Toda mudança começa por uma tarefa no quadro; funcionalidade nova começa por uma spec aprovada.
- Rode os testes antes de entregar.
- Pergunte ao usuário quando houver decisão de produto em aberto.
"""

# (id, nome, papel, prompt)
DEFAULT_AGENTS: tuple[tuple[str, str, str, str], ...] = (
    (
        "orq",
        "Orquestrador",
        "Coordena o time",
        "Você coordena o time. Lê o quadro de tarefas, quebra o trabalho em tarefas pequenas, "
        "atribui a quem tem o papel certo e acompanha até a entrega. Pergunte ao usuário quando "
        "houver decisão de produto.",
    ),
    (
        "spec",
        "Especificador",
        "Escreve as specs",
        "Você escreve specs: objetivo, fora do escopo, critérios de aceite verificáveis e riscos. "
        "Não escreve código.",
    ),
    (
        "be",
        "Dev Backend",
        "API e dados",
        "Você implementa a API e a camada de dados. Escreve testes junto com o código e roda a "
        "suíte antes de entregar.",
    ),
    (
        "fe",
        "Dev Frontend",
        "Telas",
        "Você implementa as telas. Segue o design existente, cuida de acessibilidade e de telas "
        "pequenas e testa no navegador.",
    ),
    (
        "qa",
        "QA",
        "Testes",
        "Você valida as entregas contra os critérios de aceite da spec, escreve testes de "
        "regressão e relata falhas com passos para reproduzir.",
    ),
    (
        "rev",
        "Code Reviewer",
        "Revisão de código",
        "Você revisa o código: corretude, segurança, testes e clareza. Aponta problemas com "
        "arquivo e linha e não aprova sem os testes passando.",
    ),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logo (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  provider TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  hint TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  env_enc TEXT NOT NULL,
  headers_enc TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT NOT NULL DEFAULT '',
  mcps TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
"""


def now_ms() -> int:
    return int(time.time() * 1000)


def hint(value: str) -> str:
    """Final do segredo para reconhecer qual está salvo; nada para segredos curtos."""
    return f"…{value[-4:]}" if len(value) >= 12 else "…"


def load_key(db_path: str | Path) -> bytes:
    """Chave de criptografia: em arquivo ao lado do banco, criado só para o dono.

    Quem tiver o banco e a chave lê os segredos; o arquivo separado evita que uma
    cópia só do banco os exponha.
    """
    if str(db_path) == ":memory:":
        return Fernet.generate_key()
    path = Path(db_path).parent / "secret.key"
    try:
        return path.read_bytes().strip()
    except FileNotFoundError:
        key = Fernet.generate_key()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
        return key


def sniff_image(data: bytes) -> str | None:
    """Tipo da imagem pelos primeiros bytes. SVG fica de fora: pode carregar script."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


class _Input(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class OfficeSettings(_Input):
    name: Name = "Pixel Office"
    master_prompt: Prompt = DEFAULT_MASTER_PROMPT
    prompt_files: list[PromptFile] = Field(default_factory=lambda: ["CLAUDE.md", "AGENTS.md"])

    @field_validator("prompt_files")
    @classmethod
    def _unique(cls, files: list[str]) -> list[str]:
        return [name for name in PROMPT_FILES if name in files]


class KeyInput(_Input):
    value: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]


class McpCreate(_Input):
    id: Slug
    name: Name
    transport: Literal["stdio", "http"] = "stdio"
    command: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""
    args: Annotated[list[Annotated[str, Field(max_length=1000)]], Field(max_length=50)] = Field(
        default_factory=list
    )
    url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ""
    env: SecretMap = Field(default_factory=dict)
    headers: SecretMap = Field(default_factory=dict)
    enabled: bool = True


class McpUpdate(_Input):
    name: Name | None = None
    transport: Literal["stdio", "http"] | None = None
    command: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] | None = None
    args: Annotated[list[Annotated[str, Field(max_length=1000)]], Field(max_length=50)] | None = (
        None
    )
    url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None
    env: SecretMap | None = None
    headers: SecretMap | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def _not_null(self) -> Self:
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} não pode ser null")
        return self


class AgentCreate(_Input):
    id: Slug
    name: Name
    role: Role = ""
    prompt: Prompt = ""
    provider: Provider | None = None
    model: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] = ""
    mcps: Annotated[list[Slug], Field(max_length=50)] = Field(default_factory=list)
    enabled: bool = True


class AgentUpdate(_Input):
    """O id não muda: os eventos e as tarefas se referem a ele."""

    name: Name | None = None
    role: Role | None = None
    prompt: Prompt | None = None
    provider: Provider | None = None
    model: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] | None = None
    mcps: Annotated[list[Slug], Field(max_length=50)] | None = None
    enabled: bool | None = None

    @model_validator(mode="after")
    def _not_null(self) -> Self:
        for name in self.model_fields_set - {"provider"}:
            if getattr(self, name) is None:
                raise ValueError(f"{name} não pode ser null")
        return self


class Config:
    def __init__(
        self,
        path: str | Path = ":memory:",
        *,
        seed_defaults: bool = False,
        clock: Callable[[], int] = now_ms,
        key: bytes | None = None,
    ) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        self._fernet = Fernet(key or load_key(path))
        self._clock = clock
        self._listeners: list[Callable[[], None]] = []
        if seed_defaults and self._setting("seeded") is None:
            self._seed()

    def close(self) -> None:
        self._db.close()

    def on_change(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def public(self) -> dict[str, Any]:
        """Tudo que a tela pode ver. Segredos aparecem só como dica."""
        return {
            "office": self.office(),
            "providers": self.providers(),
            "mcps": self.mcps(),
            "agents": self.agents(),
        }

    # ---------------------------------------------------------- escritório

    def office(self) -> dict[str, Any]:
        settings = OfficeSettings.model_validate(self._setting("office") or {})
        logo = self._db.execute("SELECT mime, updated_at FROM logo WHERE id = 1").fetchone()
        return {
            "name": settings.name,
            "masterPrompt": settings.master_prompt,
            "promptFiles": settings.prompt_files,
            "logo": {"mime": logo["mime"], "updatedAt": logo["updated_at"]} if logo else None,
        }

    def set_office(self, data: OfficeSettings) -> dict[str, Any]:
        self._set_setting("office", data.model_dump())
        self._changed()
        return self.office()

    def logo(self) -> tuple[str, bytes] | None:
        row = self._db.execute("SELECT mime, data FROM logo WHERE id = 1").fetchone()
        return (row["mime"], bytes(row["data"])) if row else None

    def set_logo(self, data: bytes) -> dict[str, Any]:
        if len(data) > LOGO_MAX_BYTES:
            raise BoardError("A logo passa de 2 MB.")
        mime = sniff_image(data)
        if mime is None:
            raise BoardError("Envie a logo em PNG, JPEG, WEBP ou GIF.")
        with self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO logo (id, mime, data, updated_at) VALUES (1, ?, ?, ?)",
                (mime, data, self._clock()),
            )
        self._changed()
        return self.office()

    def delete_logo(self) -> None:
        with self._db:
            self._db.execute("DELETE FROM logo WHERE id = 1")
        self._changed()

    # -------------------------------------------------------- chaves de API

    def providers(self) -> list[dict[str, Any]]:
        rows = {
            row["provider"]: row
            for row in self._db.execute("SELECT provider, hint, updated_at FROM api_keys")
        }
        return [
            {
                "id": provider,
                "label": label,
                "configured": provider in rows,
                "hint": rows[provider]["hint"] if provider in rows else None,
                "updatedAt": rows[provider]["updated_at"] if provider in rows else None,
            }
            for provider, label in PROVIDERS.items()
        ]

    def set_api_key(self, provider: str, data: KeyInput) -> None:
        self._check_provider(provider)
        with self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO api_keys (provider, value_enc, hint, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (provider, self._encrypt(data.value), hint(data.value), self._clock()),
            )
        self._changed()

    def delete_api_key(self, provider: str) -> None:
        self._check_provider(provider)
        with self._db:
            self._db.execute("DELETE FROM api_keys WHERE provider = ?", (provider,))
        self._changed()

    def api_key(self, provider: str) -> str | None:
        """Valor real da chave, para os adaptadores. Nunca vai para a tela."""
        row = self._db.execute(
            "SELECT value_enc FROM api_keys WHERE provider = ?", (provider,)
        ).fetchone()
        return self._decrypt(row["value_enc"]) if row else None

    # ----------------------------------------------------------------- MCPs

    def mcps(self) -> list[dict[str, Any]]:
        rows = self._db.execute("SELECT * FROM mcps ORDER BY position, id").fetchall()
        return [self._mcp_public(row) for row in rows]

    def mcp(self, mcp_id: str) -> dict[str, Any]:
        return self._mcp_public(self._mcp_row(mcp_id))

    def mcp_runtime(self, mcp_id: str) -> dict[str, Any]:
        """MCP com os segredos abertos, para quem for iniciar o servidor."""
        row = self._mcp_row(mcp_id)
        return {
            **self._mcp_public(row),
            "env": self._open_map(row["env_enc"]),
            "headers": self._open_map(row["headers_enc"]),
        }

    def create_mcp(self, data: McpCreate) -> dict[str, Any]:
        if self._db.execute("SELECT 1 FROM mcps WHERE id = ?", (data.id,)).fetchone():
            raise BoardError(f"Já existe um MCP com o id {data.id}")
        _check_mcp_shape(data.transport, data.command, data.url)
        env = _merge_secrets({}, data.env)
        headers = _merge_secrets({}, data.headers)
        position = self._next_position("mcps")
        with self._db:
            self._db.execute(
                "INSERT INTO mcps (id, name, transport, command, args, url, env_enc, "
                "headers_enc, enabled, position, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    data.id,
                    data.name,
                    data.transport,
                    data.command,
                    json.dumps(data.args),
                    data.url,
                    self._seal_map(env),
                    self._seal_map(headers),
                    int(data.enabled),
                    position,
                    self._clock(),
                ),
            )
        self._changed()
        return self.mcp(data.id)

    def update_mcp(self, mcp_id: str, data: McpUpdate) -> dict[str, Any]:
        row = self._mcp_row(mcp_id)
        fields = {name: getattr(data, name) for name in data.model_fields_set}
        transport = fields.get("transport", row["transport"])
        command = fields.get("command", row["command"])
        url = fields.get("url", row["url"])
        _check_mcp_shape(transport, command, url)

        values: dict[str, Any] = {}
        for name in ("name", "transport", "command", "url"):
            if name in fields:
                values[name] = fields[name]
        if "args" in fields:
            values["args"] = json.dumps(fields["args"])
        if "enabled" in fields:
            values["enabled"] = int(fields["enabled"])
        if "env" in fields:
            env = _merge_secrets(self._open_map(row["env_enc"]), fields["env"])
            values["env_enc"] = self._seal_map(env)
        if "headers" in fields:
            headers = _merge_secrets(self._open_map(row["headers_enc"]), fields["headers"])
            values["headers_enc"] = self._seal_map(headers)
        self._update("mcps", mcp_id, values)
        self._changed()
        return self.mcp(mcp_id)

    def delete_mcp(self, mcp_id: str) -> None:
        self._mcp_row(mcp_id)
        with self._db:
            self._db.execute("DELETE FROM mcps WHERE id = ?", (mcp_id,))
            for row in self._db.execute("SELECT id, mcps FROM agents").fetchall():
                allowed = json.loads(row["mcps"])
                if mcp_id in allowed:
                    allowed.remove(mcp_id)
                    self._db.execute(
                        "UPDATE agents SET mcps = ? WHERE id = ?", (json.dumps(allowed), row["id"])
                    )
        self._changed()

    # -------------------------------------------------------------- agentes

    def agents(self) -> list[dict[str, Any]]:
        rows = self._db.execute("SELECT * FROM agents ORDER BY position, id").fetchall()
        return [_agent_public(row) for row in rows]

    def agent(self, agent_id: str) -> dict[str, Any]:
        row = self._db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)).fetchone()
        if row is None:
            raise NotFound(f"Agente {agent_id} não existe")
        return _agent_public(row)

    def create_agent(self, data: AgentCreate) -> dict[str, Any]:
        if self._db.execute("SELECT 1 FROM agents WHERE id = ?", (data.id,)).fetchone():
            raise BoardError(f"Já existe um agente com o id {data.id}")
        self._check_mcps(data.mcps)
        with self._db:
            self._db.execute(
                "INSERT INTO agents (id, name, role, prompt, provider, model, mcps, enabled, "
                "position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    data.id,
                    data.name,
                    data.role,
                    data.prompt,
                    data.provider,
                    data.model,
                    json.dumps(list(dict.fromkeys(data.mcps))),
                    int(data.enabled),
                    self._next_position("agents"),
                    self._clock(),
                ),
            )
        self._changed()
        return self.agent(data.id)

    def update_agent(self, agent_id: str, data: AgentUpdate) -> dict[str, Any]:
        self.agent(agent_id)
        fields = {name: getattr(data, name) for name in data.model_fields_set}
        if "mcps" in fields:
            self._check_mcps(fields["mcps"])
            fields["mcps"] = json.dumps(list(dict.fromkeys(fields["mcps"])))
        if "enabled" in fields:
            fields["enabled"] = int(fields["enabled"])
        self._update("agents", agent_id, fields)
        self._changed()
        return self.agent(agent_id)

    def delete_agent(self, agent_id: str) -> None:
        self.agent(agent_id)
        with self._db:
            self._db.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        self._changed()

    # -------------------------------------------------------------- interno

    def _seed(self) -> None:
        with self._db:
            for position, (agent_id, name, role, prompt) in enumerate(DEFAULT_AGENTS):
                self._db.execute(
                    "INSERT OR IGNORE INTO agents (id, name, role, prompt, provider, model, mcps, "
                    "enabled, position, updated_at) VALUES (?, ?, ?, ?, NULL, '', '[]', 1, ?, ?)",
                    (agent_id, name, role, prompt, position, self._clock()),
                )
            self._db.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('seeded', 'true')"
            )

    def _setting(self, key: str) -> Any:
        row = self._db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row["value"]) if row else None

    def _set_setting(self, key: str, value: Any) -> None:
        with self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, json.dumps(value)),
            )

    def _check_provider(self, provider: str) -> None:
        if provider not in PROVIDERS:
            raise NotFound(f"Provedor {provider} não existe")

    def _check_mcps(self, ids: list[str]) -> None:
        known = {row["id"] for row in self._db.execute("SELECT id FROM mcps")}
        missing = [mcp_id for mcp_id in ids if mcp_id not in known]
        if missing:
            raise BoardError(f"MCP não existe: {', '.join(missing)}")

    def _mcp_row(self, mcp_id: str) -> sqlite3.Row:
        row = self._db.execute("SELECT * FROM mcps WHERE id = ?", (mcp_id,)).fetchone()
        if row is None:
            raise NotFound(f"MCP {mcp_id} não existe")
        return row

    def _mcp_public(self, row: sqlite3.Row) -> dict[str, Any]:
        def masked(sealed: str) -> list[dict[str, str]]:
            return [
                {"name": name, "hint": hint(value)}
                for name, value in self._open_map(sealed).items()
            ]

        return {
            "id": row["id"],
            "name": row["name"],
            "transport": row["transport"],
            "command": row["command"],
            "args": json.loads(row["args"]),
            "url": row["url"],
            "env": masked(row["env_enc"]),
            "headers": masked(row["headers_enc"]),
            "enabled": bool(row["enabled"]),
            "updatedAt": row["updated_at"],
        }

    def _next_position(self, table: str) -> int:
        row = self._db.execute(f"SELECT COALESCE(MAX(position), -1) + 1 FROM {table}").fetchone()
        return int(row[0])

    def _update(self, table: str, row_id: str, values: dict[str, Any]) -> None:
        # Os nomes de coluna vêm do código acima, nunca do pedido.
        values = {**values, "updated_at": self._clock()}
        assignments = ", ".join(f"{column} = ?" for column in values)
        with self._db:
            self._db.execute(
                f"UPDATE {table} SET {assignments} WHERE id = ?", [*values.values(), row_id]
            )

    def _encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def _decrypt(self, value: str) -> str:
        try:
            return self._fernet.decrypt(value.encode()).decode()
        except InvalidToken as exc:
            raise BoardError(
                "Não foi possível abrir um segredo salvo: a chave em secret.key mudou."
            ) from exc

    def _seal_map(self, values: dict[str, str]) -> str:
        return self._encrypt(json.dumps(values))

    def _open_map(self, sealed: str) -> dict[str, str]:
        return json.loads(self._decrypt(sealed))

    def _changed(self) -> None:
        for listener in list(self._listeners):
            listener()


def _agent_public(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "prompt": row["prompt"],
        "provider": row["provider"],
        "model": row["model"],
        "mcps": json.loads(row["mcps"]),
        "enabled": bool(row["enabled"]),
        "updatedAt": row["updated_at"],
    }


def _check_mcp_shape(transport: str, command: str, url: str) -> None:
    if transport == "stdio" and not command:
        raise BoardError("MCP do tipo stdio precisa do comando.")
    if transport == "http" and not url.startswith(("http://", "https://")):
        raise BoardError("MCP do tipo http precisa de uma URL http:// ou https://.")


def _merge_secrets(current: dict[str, str], incoming: dict[str, str | None]) -> dict[str, str]:
    """Novo mapa de segredos: null mantém o valor salvo; nomes ausentes saem."""
    merged: dict[str, str] = {}
    for name, value in incoming.items():
        if value is not None:
            merged[name] = value
        elif name in current:
            merged[name] = current[name]
        else:
            raise BoardError(f"Informe o valor de {name}.")
    return merged
