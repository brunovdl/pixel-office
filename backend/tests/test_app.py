import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from pixel_office.app import create_app
from pixel_office.hub import Hub

JOIN = {"type": "agent_joined", "agentId": "a", "name": "Agente", "role": "dev"}


@pytest.fixture
def client():
    with TestClient(create_app(Hub())) as test_client:
        yield test_client


def post(client: TestClient, event: dict, **kwargs):
    return client.post("/api/events", json=event, **kwargs)


def test_health(client):
    assert client.get("/api/health").json() == {
        "status": "ok",
        "agents": 0,
        "clients": 0,
        "simulator": False,
    }


def test_posted_event_changes_state(client):
    assert post(client, JOIN).status_code == 202
    agents = client.get("/api/state").json()["agents"]
    assert [(agent["id"], agent["status"]) for agent in agents] == [("a", "idle")]


def test_invalid_event_is_rejected_with_details(client):
    response = post(client, {"type": "agent_joined", "agentId": "a"})
    assert response.status_code == 422
    assert {tuple(error["loc"]) for error in response.json()["detail"]} == {
        ("agent_joined", "name"),
        ("agent_joined", "role"),
    }
    assert client.get("/api/state").json()["agents"] == []


def test_malformed_json_is_rejected(client):
    response = client.post(
        "/api/events", content=b"{", headers={"content-type": "application/json"}
    )
    assert response.status_code == 400


def test_websocket_sends_snapshot_then_live_events(client):
    post(client, JOIN)
    with client.websocket_connect("/ws") as ws:
        snapshot = ws.receive_json()
        assert snapshot["kind"] == "snapshot"
        assert [agent["id"] for agent in snapshot["agents"]] == ["a"]
        assert snapshot["nextSeq"] == 1
        assert [event["type"] for event in snapshot["recent"]] == ["agent_joined"]

        post(client, {"type": "task_started", "agentId": "a", "task": "x", "ts": 9})
        assert ws.receive_json() == {
            "kind": "event",
            "event": {"type": "task_started", "agentId": "a", "task": "x", "ts": 9},
        }


def test_every_client_receives_the_event(client):
    post(client, JOIN)
    with client.websocket_connect("/ws") as first, client.websocket_connect("/ws") as second:
        first.receive_json()
        second.receive_json()
        assert client.get("/api/health").json()["clients"] == 2
        post(client, {"type": "thinking", "agentId": "a"})
        assert first.receive_json()["event"]["type"] == "thinking"
        assert second.receive_json()["event"]["type"] == "thinking"
    assert client.get("/api/health").json()["clients"] == 0


def test_answering_a_decision_over_websocket(client):
    post(client, JOIN)
    post(client, {"type": "waiting_decision", "agentId": "a", "question": "Pode?"})
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["agents"][0]["question"] == "Pode?"
        ws.send_json({"kind": "answer_decision", "agentId": "a", "answer": "  Pode sim  "})
        event = ws.receive_json()["event"]
        assert (event["type"], event["answer"]) == ("decision_answered", "Pode sim")
    assert client.get("/api/state").json()["agents"][0]["status"] == "thinking"


@pytest.mark.parametrize(
    ("message", "fragment"),
    [
        ("{", "JSON inválido"),
        ("[]", "objeto"),
        ('{"kind": "outro"}', "desconhecido"),
        ('{"kind": "answer_decision", "agentId": 1}', "exige"),
        ('{"kind": "answer_decision", "agentId": "a", "answer": "x"}', "não está aguardando"),
    ],
)
def test_bad_commands_get_an_error_and_keep_the_connection(client, message, fragment):
    post(client, JOIN)
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        ws.send_text(message)
        reply = ws.receive_json()
        assert reply["kind"] == "error"
        assert fragment in reply["message"]
        post(client, {"type": "thinking", "agentId": "a"})
        assert ws.receive_json()["kind"] == "event"


class TestToken:
    @pytest.fixture
    def client(self):
        with TestClient(create_app(Hub(), token="segredo")) as test_client:
            yield test_client

    def test_post_requires_bearer_token(self, client):
        assert post(client, JOIN).status_code == 401
        assert post(client, JOIN, headers={"Authorization": "Bearer errado"}).status_code == 401
        assert post(client, JOIN, headers={"Authorization": "Bearer segredo"}).status_code == 202

    def test_state_requires_bearer_token(self, client):
        assert client.get("/api/state").status_code == 401
        assert client.get("/api/health").status_code == 200

    def test_websocket_requires_token(self, client):
        for url in ("/ws", "/ws?token=errado"):
            with pytest.raises(WebSocketDisconnect) as refused:
                with client.websocket_connect(url):
                    pass
            assert refused.value.code == 1008
        with client.websocket_connect("/ws?token=segredo") as ws:
            assert ws.receive_json()["kind"] == "snapshot"


class TestOrigin:
    def connect(self, client, origin):
        return client.websocket_connect("/ws", headers={"origin": origin})

    def test_refuses_other_sites(self, client):
        with pytest.raises(WebSocketDisconnect) as refused:
            with self.connect(client, "https://site-malicioso.example"):
                pass
        assert refused.value.code == 1008

    def test_accepts_dev_server_and_same_origin(self, client):
        for origin in ("http://localhost:5173", "http://testserver"):
            with self.connect(client, origin) as ws:
                assert ws.receive_json()["kind"] == "snapshot"


def test_serves_built_frontend(tmp_path):
    (tmp_path / "index.html").write_text("<h1>Pixel Office</h1>", "utf-8")
    with TestClient(create_app(Hub(), static_dir=tmp_path)) as client:
        assert "Pixel Office" in client.get("/").text
        assert client.get("/api/health").status_code == 200
