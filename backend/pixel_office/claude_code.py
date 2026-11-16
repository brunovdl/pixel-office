"""Tradução da saída `stream-json` do Claude Code para os eventos do escritório.

Formato: uma mensagem JSON por linha. `system/init` abre a sessão, mensagens
`assistant` trazem blocos `text`, `thinking` e `tool_use`, mensagens `user`
trazem os `tool_result`, e a última linha é o `result`.
"""

import os
from collections.abc import Callable
from typing import Any

TEXT_LIMIT = 4000
DETAIL_LIMIT = 300

Emit = Callable[..., None]


def clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def summarize_tool(name: str, data: Any, cwd: str) -> str | None:
    """Texto curto do que a ferramenta vai fazer, para o monitor e o log."""
    if not isinstance(data, dict):
        return None

    def path(value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        try:
            relative = os.path.relpath(value, cwd)
        except ValueError:
            return value
        return value if relative.startswith("..") else relative

    for key in ("file_path", "notebook_path", "path"):
        if key in data and (found := path(data[key])):
            if name in ("Grep", "Glob") and isinstance(data.get("pattern"), str):
                return clip(f"{data['pattern']} em {found}", DETAIL_LIMIT)
            return clip(found, DETAIL_LIMIT)
    if name == "Bash":
        text = data.get("description") or data.get("command")
        return clip(str(text).splitlines()[0], DETAIL_LIMIT) if text else None
    if name == "TodoWrite" and isinstance(data.get("todos"), list):
        return f"{len(data['todos'])} itens"
    for key in ("pattern", "url", "query", "description", "prompt", "command"):
        if isinstance(data.get(key), str) and data[key].strip():
            return clip(data[key].splitlines()[0], DETAIL_LIMIT)
    for value in data.values():
        if isinstance(value, str) and value.strip():
            return clip(value.splitlines()[0], DETAIL_LIMIT)
    return None


class ClaudeCodeTranslator:
    """Recebe as mensagens do Claude Code e chama `emit(tipo, **campos)`."""

    def __init__(self, emit: Emit, cwd: str) -> None:
        self._emit = emit
        self._cwd = cwd
        self._open_tools: dict[str, str] = {}
        self.result: dict[str, Any] | None = None
        self.session_id: str | None = None

    def feed(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "system":
            self._system(message)
        elif kind == "assistant":
            for block in _blocks(message):
                self._assistant_block(block)
        elif kind == "user":
            for block in _blocks(message):
                if block.get("type") == "tool_result":
                    tool = self._open_tools.pop(str(block.get("tool_use_id")), "Ferramenta")
                    self._emit("tool_finished", tool=tool, ok=not block.get("is_error", False))
        elif kind == "result":
            self.result = message

    def close(self) -> None:
        """Fecha ferramentas que ficaram abertas (processo interrompido)."""
        for tool in self._open_tools.values():
            self._emit("tool_finished", tool=tool, ok=False)
        self._open_tools.clear()

    def _system(self, message: dict[str, Any]) -> None:
        subtype = message.get("subtype")
        if subtype == "init":
            self.session_id = message.get("session_id")
            self._emit("thinking")
        elif subtype == "api_retry":
            attempt = message.get("attempt")
            error = message.get("error", "erro")
            self._emit(
                "message", text=f"A API pediu nova tentativa ({error}), tentativa {attempt}."
            )

    def _assistant_block(self, block: dict[str, Any]) -> None:
        kind = block.get("type")
        if kind == "text" and str(block.get("text", "")).strip():
            self._emit("message", text=clip(str(block["text"]), TEXT_LIMIT))
        elif kind == "thinking":
            self._emit("thinking")
        elif kind == "tool_use":
            name = clip(str(block.get("name") or "Ferramenta"), 200)
            self._open_tools[str(block.get("id"))] = name
            detail = summarize_tool(name, block.get("input"), self._cwd)
            if detail:
                self._emit("tool_started", tool=name, detail=detail)
            else:
                self._emit("tool_started", tool=name)


def _blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = (message.get("message") or {}).get("content")
    if isinstance(content, list):
        return [block for block in content if isinstance(block, dict)]
    return []
