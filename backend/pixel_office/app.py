"""Aplicação HTTP e WebSocket."""

import asyncio
import hmac
import json
from collections.abc import AsyncIterator, Awaitable
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import anyio
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
from .config import (
    LOGO_MAX_BYTES,
    AgentCreate,
    AgentUpdate,
    KeyInput,
    McpCreate,
    McpUpdate,
    OfficeSettings,
)
from .hub import Hub, Subscription
from .roster import Roster
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
    roster: bool = False,
) -> FastAPI:
    """Monta a aplicação.

    token: se definido, é exigido em `POST /api/events` (cabeçalho
        `Authorization: Bearer`) e no WebSocket (parâmetro `?token=`).
    allowed_origins: origens de navegador aceitas no WebSocket, além da própria.
    simulator: se definido, roda enquanto a aplicação estiver no ar.
    roster: se verdadeiro, os agentes ativos da configuração entram no escritório.
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
    config = hub.config
    if roster:
        Roster(hub).sync()

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
            # Grupo do anyio: quando um lado termina, o outro é cancelado, e o
            # cancelamento vindo do servidor alcança os dois.
            async with anyio.create_task_group() as group:

                async def until_done(job: Awaitable[None]) -> None:
                    await job
                    group.cancel_scope.cancel()

                group.start_soon(until_done, _send_events(websocket, subscription))
                group.start_soon(until_done, _receive_commands(websocket, hub))

    # Configuração. Segredos entram por aqui e nunca voltam: a leitura traz só dicas.

    @app.get("/api/config", dependencies=auth)
    async def get_config() -> dict[str, Any]:
        return config.public()

    @app.put("/api/config/office", dependencies=auth)
    async def put_office(data: OfficeSettings) -> dict[str, Any]:
        return config.set_office(data)

    @app.get("/api/config/logo")
    async def get_logo(request: Request) -> Response:
        # A tag <img> não manda cabeçalho; o token pode vir em ?token=.
        if token is not None and not token_ok(request.query_params.get("token")):
            require_bearer(request)
        logo = config.logo()
        if logo is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Sem logo")
        mime, data = logo
        return Response(
            data,
            media_type=mime,
            headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"},
        )

    @app.put("/api/config/logo", dependencies=auth)
    async def put_logo(request: Request) -> dict[str, Any]:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > LOGO_MAX_BYTES:
            raise HTTPException(413, "A logo passa de 2 MB.")
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > LOGO_MAX_BYTES:
                raise HTTPException(413, "A logo passa de 2 MB.")
        return config.set_logo(bytes(data))

    @app.delete("/api/config/logo", status_code=204, dependencies=auth)
    async def delete_logo() -> Response:
        config.delete_logo()
        return Response(status_code=204)

    @app.put("/api/config/keys/{provider}", status_code=204, dependencies=auth)
    async def put_key(provider: str, data: KeyInput) -> Response:
        config.set_api_key(provider, data)
        return Response(status_code=204)

    @app.delete("/api/config/keys/{provider}", status_code=204, dependencies=auth)
    async def delete_key(provider: str) -> Response:
        config.delete_api_key(provider)
        return Response(status_code=204)

    @app.post("/api/config/mcps", status_code=status.HTTP_201_CREATED, dependencies=auth)
    async def create_mcp(data: McpCreate) -> dict[str, Any]:
        return config.create_mcp(data)

    @app.patch("/api/config/mcps/{mcp_id}", dependencies=auth)
    async def update_mcp(mcp_id: str, data: McpUpdate) -> dict[str, Any]:
        return config.update_mcp(mcp_id, data)

    @app.delete("/api/config/mcps/{mcp_id}", status_code=204, dependencies=auth)
    async def delete_mcp(mcp_id: str) -> Response:
        config.delete_mcp(mcp_id)
        return Response(status_code=204)

    @app.post("/api/config/agents", status_code=status.HTTP_201_CREATED, dependencies=auth)
    async def create_agent(data: AgentCreate) -> dict[str, Any]:
        return config.create_agent(data)

    @app.patch("/api/config/agents/{agent_id}", dependencies=auth)
    async def update_agent(agent_id: str, data: AgentUpdate) -> dict[str, Any]:
        return config.update_agent(agent_id, data)

    @app.delete("/api/config/agents/{agent_id}", status_code=204, dependencies=auth)
    async def delete_agent(agent_id: str) -> Response:
        config.delete_agent(agent_id)
        return Response(status_code=204)

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
