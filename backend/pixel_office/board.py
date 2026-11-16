"""Quadro de tarefas e specs, guardado em SQLite.

No fio os campos vão em camelCase (`agentId`, `specId`), como nos eventos.
"""

import json
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from pydantic.alias_generators import to_camel

TaskStatus = Literal["pending", "in_progress", "review", "blocked", "done"]
SpecStatus = Literal["draft", "approved", "in_progress", "implemented"]

Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[str, Field(max_length=20_000)]
SpecBody = Annotated[str, Field(max_length=200_000)]
Criterion = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]
AgentRef = Annotated[str, Field(min_length=1, max_length=64)]
Criteria = Annotated[list[Criterion], Field(max_length=500)]

SCHEMA = """
CREATE TABLE IF NOT EXISTS specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  agent_id TEXT,
  spec_id INTEGER REFERENCES specs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_spec ON tasks(spec_id);
"""


class BoardError(ValueError):
    """Pedido inválido ao quadro; a mensagem vai para o usuário."""


class NotFound(BoardError):
    pass


class _Input(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class TaskCreate(_Input):
    title: Title
    description: Description = ""
    status: TaskStatus = "pending"
    agent_id: AgentRef | None = None
    spec_id: int | None = None


class TaskUpdate(_Input):
    """Só os campos enviados mudam. `agentId` e `specId` aceitam null para limpar."""

    title: Title | None = None
    description: Description | None = None
    status: TaskStatus | None = None
    agent_id: AgentRef | None = None
    spec_id: int | None = None

    @model_validator(mode="after")
    def _required_not_null(self) -> Self:
        for name in ("title", "description", "status"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} não pode ser null")
        return self


class SpecCreate(_Input):
    title: Title
    status: SpecStatus = "draft"
    body: SpecBody = ""
    criteria: Criteria = Field(default_factory=list)


class SpecUpdate(_Input):
    title: Title | None = None
    status: SpecStatus | None = None
    body: SpecBody | None = None
    criteria: Criteria | None = None

    @model_validator(mode="after")
    def _not_null(self) -> Self:
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} não pode ser null")
        return self


def now_ms() -> int:
    return int(time.time() * 1000)


def _task_wire(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "status": row["status"],
        "agentId": row["agent_id"],
        "specId": row["spec_id"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _spec_summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "status": row["status"],
        "criteriaCount": row["criteria_count"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


_SPEC_SUMMARY_SQL = (
    "SELECT id, title, status, json_array_length(criteria) AS criteria_count, "
    "created_at, updated_at FROM specs"
)
_TASK_COLUMNS = {
    "title": "title",
    "description": "description",
    "status": "status",
    "agent_id": "agent_id",
    "spec_id": "spec_id",
}
_SPEC_COLUMNS = {"title": "title", "status": "status", "body": "body", "criteria": "criteria"}


class Board:
    def __init__(self, path: str | Path = ":memory:", clock: Callable[[], int] = now_ms) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._clock = clock
        self._listeners: list[Callable[[], None]] = []

    def close(self) -> None:
        self._db.close()

    def on_change(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def summary(self) -> dict[str, Any]:
        """Tudo que as telas precisam para as listas (specs sem o texto)."""
        return {"tasks": self.tasks(), "specs": self.specs()}

    def is_empty(self) -> bool:
        row = self._db.execute(
            "SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM specs)"
        ).fetchone()
        return row[0] == 0

    # ------------------------------------------------------------ tarefas

    def tasks(self) -> list[dict[str, Any]]:
        rows = self._db.execute("SELECT * FROM tasks ORDER BY id").fetchall()
        return [_task_wire(row) for row in rows]

    def task(self, task_id: int) -> dict[str, Any]:
        row = self._db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise NotFound(f"Tarefa {task_id} não existe")
        return _task_wire(row)

    def create_task(self, data: TaskCreate) -> dict[str, Any]:
        self._check_spec(data.spec_id)
        now = self._clock()
        with self._db:
            cursor = self._db.execute(
                "INSERT INTO tasks (title, description, status, agent_id, spec_id, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (data.title, data.description, data.status, data.agent_id, data.spec_id, now, now),
            )
        task = self.task(cursor.lastrowid or 0)
        self._changed()
        return task

    def update_task(self, task_id: int, data: TaskUpdate) -> dict[str, Any]:
        self.task(task_id)
        fields = {name: getattr(data, name) for name in data.model_fields_set}
        if "spec_id" in fields:
            self._check_spec(fields["spec_id"])
        self._update("tasks", _TASK_COLUMNS, task_id, fields)
        task = self.task(task_id)
        self._changed()
        return task

    def delete_task(self, task_id: int) -> None:
        with self._db:
            cursor = self._db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        if cursor.rowcount == 0:
            raise NotFound(f"Tarefa {task_id} não existe")
        self._changed()

    # -------------------------------------------------------------- specs

    def specs(self) -> list[dict[str, Any]]:
        rows = self._db.execute(f"{_SPEC_SUMMARY_SQL} ORDER BY id").fetchall()
        return [_spec_summary(row) for row in rows]

    def spec(self, spec_id: int) -> dict[str, Any]:
        row = self._db.execute(
            "SELECT *, json_array_length(criteria) AS criteria_count FROM specs WHERE id = ?",
            (spec_id,),
        ).fetchone()
        if row is None:
            raise NotFound(f"Spec {spec_id} não existe")
        return {**_spec_summary(row), "body": row["body"], "criteria": json.loads(row["criteria"])}

    def create_spec(self, data: SpecCreate) -> dict[str, Any]:
        now = self._clock()
        with self._db:
            cursor = self._db.execute(
                "INSERT INTO specs (title, status, body, criteria, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (data.title, data.status, data.body, json.dumps(data.criteria), now, now),
            )
        spec = self.spec(cursor.lastrowid or 0)
        self._changed()
        return spec

    def update_spec(self, spec_id: int, data: SpecUpdate) -> dict[str, Any]:
        self.spec(spec_id)
        fields: dict[str, Any] = {name: getattr(data, name) for name in data.model_fields_set}
        if "criteria" in fields:
            fields["criteria"] = json.dumps(fields["criteria"])
        self._update("specs", _SPEC_COLUMNS, spec_id, fields)
        spec = self.spec(spec_id)
        self._changed()
        return spec

    def delete_spec(self, spec_id: int) -> None:
        """Apaga a spec; as tarefas ligadas a ela continuam, sem spec."""
        with self._db:
            cursor = self._db.execute("DELETE FROM specs WHERE id = ?", (spec_id,))
        if cursor.rowcount == 0:
            raise NotFound(f"Spec {spec_id} não existe")
        self._changed()

    # ------------------------------------------------------------ interno

    def _check_spec(self, spec_id: int | None) -> None:
        if spec_id is None:
            return
        row = self._db.execute("SELECT 1 FROM specs WHERE id = ?", (spec_id,)).fetchone()
        if row is None:
            raise BoardError(f"Spec {spec_id} não existe")

    def _update(
        self, table: str, columns: dict[str, str], row_id: int, fields: dict[str, Any]
    ) -> None:
        if not fields:
            return
        # Os nomes de coluna vêm da lista fixa acima, nunca do pedido.
        assignments = ", ".join(f"{columns[name]} = ?" for name in fields)
        values = [*fields.values(), self._clock(), row_id]
        with self._db:
            self._db.execute(
                f"UPDATE {table} SET {assignments}, updated_at = ? WHERE id = ?", values
            )

    def _changed(self) -> None:
        for listener in list(self._listeners):
            listener()
