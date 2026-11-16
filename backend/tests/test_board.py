import pytest
from pydantic import ValidationError

from pixel_office.board import (
    Board,
    BoardError,
    NotFound,
    SpecCreate,
    SpecUpdate,
    TaskCreate,
    TaskUpdate,
)


@pytest.fixture
def board():
    ticks = iter(range(1000, 100_000))
    board = Board(clock=lambda: next(ticks))
    yield board
    board.close()


def task(**fields) -> TaskCreate:
    return TaskCreate.model_validate({"title": "Tarefa", **fields})


def spec(**fields) -> SpecCreate:
    return SpecCreate.model_validate({"title": "Spec", **fields})


def test_creates_task_with_defaults(board):
    created = board.create_task(task(title="  Criar endpoint  "))
    assert created == {
        "id": 1,
        "title": "Criar endpoint",
        "description": "",
        "status": "pending",
        "agentId": None,
        "specId": None,
        "createdAt": 1000,
        "updatedAt": 1000,
    }
    assert board.tasks() == [created]


def test_update_changes_only_sent_fields(board):
    created = board.create_task(task(agentId="be", description="detalhe"))
    updated = board.update_task(created["id"], TaskUpdate.model_validate({"status": "review"}))
    assert updated["status"] == "review"
    assert updated["agentId"] == "be"
    assert updated["description"] == "detalhe"
    assert updated["updatedAt"] > created["updatedAt"]


def test_update_with_null_clears_assignee_and_spec(board):
    spec_id = board.create_spec(spec())["id"]
    created = board.create_task(task(agentId="be", specId=spec_id))
    updated = board.update_task(
        created["id"], TaskUpdate.model_validate({"agentId": None, "specId": None})
    )
    assert (updated["agentId"], updated["specId"]) == (None, None)


def test_update_rejects_null_title_or_status():
    with pytest.raises(ValidationError):
        TaskUpdate.model_validate({"title": None})
    with pytest.raises(ValidationError):
        TaskUpdate.model_validate({"status": None})
    with pytest.raises(ValidationError):
        SpecUpdate.model_validate({"criteria": None})


@pytest.mark.parametrize(
    "fields",
    [{"title": ""}, {"title": "   "}, {"title": "x" * 201}, {"status": "feito"}, {"extra": 1}],
)
def test_rejects_invalid_task(fields):
    with pytest.raises(ValidationError):
        task(**fields)


def test_task_must_point_to_existing_spec(board):
    with pytest.raises(BoardError, match="Spec 9 não existe"):
        board.create_task(task(specId=9))
    created = board.create_task(task())
    with pytest.raises(BoardError):
        board.update_task(created["id"], TaskUpdate.model_validate({"specId": 9}))


def test_missing_items_raise_not_found(board):
    for call in (
        lambda: board.task(1),
        lambda: board.update_task(1, TaskUpdate()),
        lambda: board.delete_task(1),
        lambda: board.spec(1),
        lambda: board.update_spec(1, SpecUpdate()),
        lambda: board.delete_spec(1),
    ):
        with pytest.raises(NotFound):
            call()


def test_delete_task(board):
    created = board.create_task(task())
    board.delete_task(created["id"])
    assert board.tasks() == []


def test_spec_keeps_criteria_and_summary_counts_them(board):
    created = board.create_spec(spec(body="# Texto", criteria=[" CA um ", "CA dois"]))
    assert created["criteria"] == ["CA um", "CA dois"]
    assert created["body"] == "# Texto"
    assert created["status"] == "draft"
    assert board.specs() == [
        {
            "id": 1,
            "title": "Spec",
            "status": "draft",
            "criteriaCount": 2,
            "createdAt": 1000,
            "updatedAt": 1000,
        }
    ]


def test_update_spec(board):
    created = board.create_spec(spec(criteria=["a"]))
    updated = board.update_spec(
        created["id"], SpecUpdate.model_validate({"status": "approved", "criteria": ["a", "b"]})
    )
    assert (updated["status"], updated["criteria"], updated["title"]) == (
        "approved",
        ["a", "b"],
        "Spec",
    )


def test_deleting_spec_keeps_its_tasks_without_spec(board):
    spec_id = board.create_spec(spec())["id"]
    created = board.create_task(task(specId=spec_id))
    board.delete_spec(spec_id)
    assert board.task(created["id"])["specId"] is None


def test_every_change_notifies_listeners(board):
    calls = []
    stop = board.on_change(lambda: calls.append(1))
    spec_id = board.create_spec(spec())["id"]
    task_id = board.create_task(task())["id"]
    board.update_task(task_id, TaskUpdate.model_validate({"status": "done"}))
    board.update_spec(spec_id, SpecUpdate.model_validate({"status": "approved"}))
    board.delete_task(task_id)
    board.delete_spec(spec_id)
    assert len(calls) == 6
    stop()
    board.create_task(task())
    assert len(calls) == 6


def test_failed_change_does_not_notify(board):
    calls = []
    board.on_change(lambda: calls.append(1))
    with pytest.raises(BoardError):
        board.create_task(task(specId=5))
    assert calls == []


def test_data_survives_reopening_the_file(tmp_path):
    path = tmp_path / "sub" / "board.db"
    first = Board(path)
    spec_id = first.create_spec(spec(criteria=["a"]))["id"]
    first.create_task(task(specId=spec_id))
    first.close()

    second = Board(path)
    assert [t["specId"] for t in second.tasks()] == [spec_id]
    assert second.spec(spec_id)["criteria"] == ["a"]
    second.close()


def test_is_empty(board):
    assert board.is_empty()
    board.create_task(task())
    assert not board.is_empty()
