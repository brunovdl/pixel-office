"""Aplicação HTTP e WebSocket."""

import asyncio
import hmac
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from .board import BoardError, NotFound, SpecCreate, SpecUpdate, TaskCreate, TaskUpdate
from .hub import Hub, Subscription
from .simulator import Simulator

DEFAULT_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")

# Códigos de fechamento do WebSocket.
WS_POLICY_VIOLATION = 1008
WS_TRY_AGAIN_LATER = 1013


def create_app(
    hub: Hub | None = None,
    *,
    token: str | None = None,
    allowed_origins: tuple[str, ...] = DEFAULT_ORIGINS,
    simulator: Simulator | None = None,
    static_dir: Path | None = None,
) -> FastAPI:
    """Monta a aplicação.

    token: se definido, é exigido em `POST /api/events` (cabeçalho
        `Authorization: Bearer`) e no WebSocket (parâmetro `?token=`).
    allowed_origins: origens de navegador aceitas no WebSocket, além da própria.
    simulator: se definido, roda enquanto a aplicação estiver no ar.
    static_dir: pasta com o frontend compilado, servida em `/`.
    """
    hub = hub or Hub()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(simulator.run()) if simulator else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    app = FastAPI(title="Pixel Office", lifespan=lifespan)
    app.state.hub = hub
    board = hub.board

    @app.exception_handler(BoardError)
    async def board_error(_: Request, exc: BoardError) -> JSONResponse:
        code = 404 if isinstance(exc, NotFound) else 422
        return JSONResponse({"detail": str(exc)}, status_code=code)

    def token_ok(given: str | None) -> bool:
        if token is None:
            return True
        return given is not None and hmac.compare_digest(given.encode(), token.encode())

    def origin_ok(websocket: WebSocket) -> bool:
        # Navegador sempre manda Origin; sem essa checagem, qualquer site aberto
        # na máquina poderia ler os eventos e responder decisões.
        origin = websocket.headers.get("origin")
        if origin is None:
            return True
        if origin in allowed_origins:
            return True
        return urlsplit(origin).netloc == websocket.headers.get("host")

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "agents": len(hub.state.agents),
            "clients": hub.subscriber_count,
            "simulator": simulator is not None,
        }

    def require_bearer(request: Request) -> None:
        scheme, _, given = request.headers.get("authorization", "").partition(" ")
        if token is not None and (scheme.lower() != "bearer" or not token_ok(given)):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token ausente ou inválido")

    auth = [Depends(require_bearer)]

    @app.get("/api/state", dependencies=auth)
    async def state() -> dict[str, Any]:
        return hub.state.snapshot()

    @app.post("/api/events", status_code=status.HTTP_202_ACCEPTED, dependencies=auth)
    async def post_event(request: Request) -> dict[str, bool]:
        try:
            data = await request.json()
        except json.JSONDecodeError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "JSON inválido") from exc
        try:
            hub.ingest(data)
        except ValidationError as exc:
            raise HTTPException(
                422,
                exc.errors(include_url=False, include_input=False, include_context=False),
            ) from exc
        return {"ok": True}

    # Tarefas e specs. Toda mudança chega às telas pelo WebSocket ("board").

    @app.get("/api/tasks", dependencies=auth)
    async def list_tasks() -> dict[str, Any]:
        return {"tasks": board.tasks()}

    @app.post("/api/tasks", status_code=status.HTTP_201_CREATED, dependencies=auth)
    async def create_task(data: TaskCreate) -> dict[str, Any]:
        return board.create_task(data)

    @app.get("/api/tasks/{task_id}", dependencies=auth)
    async def get_task(task_id: int) -> dict[str, Any]:
        return board.task(task_id)

    @app.patch("/api/tasks/{task_id}", dependencies=auth)
    async def update_task(task_id: int, data: TaskUpdate) -> dict[str, Any]:
        return board.update_task(task_id, data)

    @app.delete("/api/tasks/{task_id}", status_code=204, dependencies=auth)
    async def delete_task(task_id: int) -> Response:
        board.delete_task(task_id)
        return Response(status_code=204)

    @app.get("/api/specs", dependencies=auth)
    async def list_specs() -> dict[str, Any]:
        return {"specs": board.specs()}

    @app.post("/api/specs", status_code=status.HTTP_201_CREATED, dependencies=auth)
    async def create_spec(data: SpecCreate) -> dict[str, Any]:
        return board.create_spec(data)

    @app.get("/api/specs/{spec_id}", dependencies=auth)
    async def get_spec(spec_id: int) -> dict[str, Any]:
        return board.spec(spec_id)

    @app.patch("/api/specs/{spec_id}", dependencies=auth)
    async def update_spec(spec_id: int, data: SpecUpdate) -> dict[str, Any]:
        return board.update_spec(spec_id, data)

    @app.delete("/api/specs/{spec_id}", status_code=204, dependencies=auth)
    async def delete_spec(spec_id: int) -> Response:
        board.delete_spec(spec_id)
        return Response(status_code=204)

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        if not origin_ok(websocket) or not token_ok(websocket.query_params.get("token")):
            await websocket.close(code=WS_POLICY_VIOLATION)
            return
        await websocket.accept()
        with hub.subscribe() as subscription:
            await websocket.send_json({"kind": "snapshot", **subscription.snapshot})
            tasks = {
                asyncio.create_task(_send_events(websocket, subscription)),
                asyncio.create_task(_receive_commands(websocket, hub)),
            }
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    if static_dir is not None:
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="frontend")

    return app


async def _send_events(websocket: WebSocket, subscription: Subscription) -> None:
    while True:
        message = await subscription.queue.get()
        if message is None:
            await websocket.close(code=WS_TRY_AGAIN_LATER, reason="cliente lento")
            return
        try:
            await websocket.send_json(message)
        except (WebSocketDisconnect, RuntimeError):
            return


async def _receive_commands(websocket: WebSocket, hub: Hub) -> None:
    while True:
        try:
            text = await websocket.receive_text()
        except WebSocketDisconnect:
            return
        error = _handle_command(text, hub)
        if error:
            await websocket.send_json({"kind": "error", "message": error})


def _handle_command(text: str, hub: Hub) -> str | None:
    """Executa um comando do cliente. Devolve a mensagem de erro, se houver."""
    try:
        command = json.loads(text)
    except json.JSONDecodeError:
        return "JSON inválido"
    if not isinstance(command, dict):
        return "Comando deve ser um objeto"

    if command.get("kind") == "answer_decision":
        agent_id = command.get("agentId")
        answer = command.get("answer", "")
        if not isinstance(agent_id, str) or not isinstance(answer, str):
            return "answer_decision exige agentId e answer em texto"
        if len(answer) > 4000:
            return "Resposta longa demais"
        if not hub.answer_decision(agent_id, answer.strip()):
            return f"O agente {agent_id!r} não está aguardando decisão"
        return None

    return f"Comando desconhecido: {command.get('kind')!r}"
