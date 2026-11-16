from pixel_office.claude_code import ClaudeCodeTranslator, clip, summarize_tool


def run(messages, cwd="/repo"):
    events = []
    translator = ClaudeCodeTranslator(lambda kind, **fields: events.append((kind, fields)), cwd)
    for message in messages:
        translator.feed(message)
    return translator, events


def test_translates_a_session():
    translator, events = run(
        [
            {"type": "system", "subtype": "init", "session_id": "s1"},
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "thinking", "thinking": "..."},
                        {"type": "text", "text": "  Vou ler.  "},
                        {
                            "type": "tool_use",
                            "id": "a",
                            "name": "Read",
                            "input": {"file_path": "/repo/src/x.py"},
                        },
                    ]
                },
            },
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "a"}]}},
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "b",
                            "name": "Bash",
                            "input": {"command": "pytest -q\nmais"},
                        }
                    ]
                },
            },
            {
                "type": "user",
                "message": {
                    "content": [{"type": "tool_result", "tool_use_id": "b", "is_error": True}]
                },
            },
            {"type": "system", "subtype": "api_retry", "attempt": 2, "error": "rate_limit"},
            {"type": "result", "subtype": "success", "is_error": False, "result": "Pronto"},
        ]
    )
    assert events == [
        ("thinking", {}),
        ("thinking", {}),
        ("message", {"text": "Vou ler."}),
        ("tool_started", {"tool": "Read", "detail": "src/x.py"}),
        ("tool_finished", {"tool": "Read", "ok": True}),
        ("tool_started", {"tool": "Bash", "detail": "pytest -q"}),
        ("tool_finished", {"tool": "Bash", "ok": False}),
        ("message", {"text": "A API pediu nova tentativa (rate_limit), tentativa 2."}),
    ]
    assert translator.session_id == "s1"
    assert translator.result["result"] == "Pronto"


def test_ignores_garbage_and_closes_open_tools():
    translator, events = run(
        [
            "texto",
            {"type": "desconhecido"},
            {"type": "assistant", "message": {"content": "não é lista"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "   "}]}},
            {
                "type": "assistant",
                "message": {
                    "content": [{"type": "tool_use", "id": "x", "name": "Edit", "input": {}}]
                },
            },
        ]
    )
    translator.close()
    assert events == [
        ("tool_started", {"tool": "Edit"}),
        ("tool_finished", {"tool": "Edit", "ok": False}),
    ]


def test_summaries():
    assert (
        summarize_tool("Bash", {"command": "ls", "description": "Lista arquivos"}, "/r")
        == "Lista arquivos"
    )
    assert summarize_tool("Grep", {"pattern": "TODO", "path": "/r/src"}, "/r") == "TODO em src"
    assert summarize_tool("Read", {"file_path": "/fora/x"}, "/r") == "/fora/x"
    assert summarize_tool("TodoWrite", {"todos": [1, 2]}, "/r") == "2 itens"
    assert summarize_tool("WebFetch", {"url": "https://x.dev"}, "/r") == "https://x.dev"
    assert summarize_tool("mcp__gh__issue", {"number": 3, "title": "Bug"}, "/r") == "Bug"
    assert summarize_tool("X", "não é dict", "/r") is None
    assert len(summarize_tool("Bash", {"command": "x" * 1000}, "/r")) == 300


def test_clip():
    assert clip("  abc ", 10) == "abc"
    assert clip("abcdef", 4) == "abc…"
