"""Sobe o servidor: `python -m pixel_office --simulate`."""

import argparse
import ipaddress
import os
import sys
from pathlib import Path

import uvicorn

from .app import DEFAULT_ORIGINS, create_app
from .board import Board
from .hub import Hub
from .simulator import Simulator

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "pixel-office.db"


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def main() -> None:
    env = os.environ
    parser = argparse.ArgumentParser(prog="pixel_office", description=__doc__)
    parser.add_argument("--host", default=env.get("PIXEL_OFFICE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(env.get("PIXEL_OFFICE_PORT", "8000")))
    parser.add_argument("--simulate", action="store_true", help="roda o time simulado")
    parser.add_argument("--seed", type=int, default=1, help="semente do simulador")
    parser.add_argument("--speed", type=float, default=1.0, help="velocidade do simulador")
    parser.add_argument(
        "--db",
        default=env.get("PIXEL_OFFICE_DB"),
        help=f"arquivo SQLite de tarefas e specs (padrão: {DEFAULT_DB}; "
        "com --simulate, só em memória)",
    )
    args = parser.parse_args()

    token = env.get("PIXEL_OFFICE_TOKEN") or None
    if not is_loopback(args.host) and token is None:
        sys.exit(
            f"Recusado: --host {args.host} expõe o servidor na rede sem autenticação. "
            "Defina PIXEL_OFFICE_TOKEN ou use 127.0.0.1."
        )

    origins = tuple(
        origin.strip()
        for origin in env.get("PIXEL_OFFICE_ORIGINS", ",".join(DEFAULT_ORIGINS)).split(",")
        if origin.strip()
    )

    db = args.db or (":memory:" if args.simulate else DEFAULT_DB)
    hub = Hub(board=Board(db))
    app = create_app(
        hub,
        token=token,
        allowed_origins=origins,
        simulator=Simulator(hub, seed=args.seed, speed=args.speed) if args.simulate else None,
        static_dir=FRONTEND_DIST if FRONTEND_DIST.is_dir() else None,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
