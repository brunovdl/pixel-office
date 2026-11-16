import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  BoardApi,
  countSpecTabs,
  countTaskTabs,
  errorMessage,
  filterSpecs,
  filterTasks,
  parseCriteria,
  specCode,
  taskCode,
  tasksOfSpec,
  type SpecSummary,
  type Task,
} from "../src/board";

const task = (id: number, fields: Partial<Task> = {}): Task => ({
  id,
  title: `Tarefa ${id}`,
  description: "",
  status: "pending",
  agentId: null,
  specId: null,
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});

const spec = (id: number, fields: Partial<SpecSummary> = {}): SpecSummary => ({
  id,
  title: `Spec ${id}`,
  status: "draft",
  criteriaCount: 0,
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});

const names: Record<string, string> = { be: "Dev Backend", qa: "QA" };
const agentName = (id: string) => names[id] ?? id;

describe("códigos", () => {
  it("formata com três dígitos", () => {
    expect(taskCode(7)).toBe("T-007");
    expect(taskCode(1234)).toBe("T-1234");
    expect(specCode(16)).toBe("016");
  });
});

describe("filterTasks", () => {
  const tasks = [
    task(1, { status: "done", agentId: "be", title: "Criar endpoint de sessão" }),
    task(2, { status: "in_progress", agentId: "qa", title: "Testar relatório" }),
    task(3, { status: "blocked", title: "Migração" }),
    task(4, { status: "review", agentId: "be", title: "Revisão de validação" }),
  ];

  it("ativas são todas menos as concluídas, mais novas primeiro", () => {
    expect(filterTasks(tasks, "active", "", agentName).map((t) => t.id)).toEqual([4, 3, 2]);
    expect(filterTasks(tasks, "done", "", agentName).map((t) => t.id)).toEqual([1]);
    expect(filterTasks(tasks, "all", "", agentName)).toHaveLength(4);
  });

  it("busca por código, título e nome do agente, sem acento e sem caixa", () => {
    expect(filterTasks(tasks, "all", "t-003", agentName).map((t) => t.id)).toEqual([3]);
    expect(filterTasks(tasks, "all", "RELATORIO", agentName).map((t) => t.id)).toEqual([2]);
    expect(filterTasks(tasks, "all", "backend", agentName).map((t) => t.id)).toEqual([4, 1]);
    expect(filterTasks(tasks, "all", "backend sessao", agentName).map((t) => t.id)).toEqual([1]);
    expect(filterTasks(tasks, "all", "nada", agentName)).toEqual([]);
  });

  it("conta cada aba", () => {
    expect(countTaskTabs(tasks)).toEqual({
      active: 3,
      pending: 0,
      in_progress: 1,
      review: 1,
      blocked: 1,
      done: 1,
      all: 4,
    });
  });
});

describe("filterSpecs", () => {
  const specs = [
    spec(14, { status: "implemented", title: "Resposta final visível" }),
    spec(15, { status: "implemented", title: "Histórico por agente" }),
    spec(16, { title: "Anexos no chat" }),
  ];

  it("filtra por status e busca por número ou título", () => {
    expect(filterSpecs(specs, "all", "").map((s) => s.id)).toEqual([16, 15, 14]);
    expect(filterSpecs(specs, "implemented", "").map((s) => s.id)).toEqual([15, 14]);
    expect(filterSpecs(specs, "all", "016").map((s) => s.id)).toEqual([16]);
    expect(filterSpecs(specs, "all", "historico").map((s) => s.id)).toEqual([15]);
  });

  it("conta cada aba", () => {
    expect(countSpecTabs(specs)).toEqual({
      all: 3,
      draft: 1,
      approved: 0,
      in_progress: 0,
      implemented: 2,
    });
  });
});

it("tasksOfSpec devolve as tarefas da spec em ordem", () => {
  const tasks = [task(3, { specId: 1 }), task(1, { specId: 1 }), task(2, { specId: 2 })];
  expect(tasksOfSpec(tasks, 1).map((t) => t.id)).toEqual([1, 3]);
});

it("parseCriteria aceita um por linha e tira marcadores", () => {
  expect(parseCriteria("- Primeiro\n\nCA-2: Segundo\n3. Terceiro\n  * Quarto  \n")).toEqual([
    "Primeiro",
    "Segundo",
    "Terceiro",
    "Quarto",
  ]);
});

describe("errorMessage", () => {
  it("lê texto ou lista de erros do backend", () => {
    expect(errorMessage("Spec 9 não existe", 422)).toBe("Spec 9 não existe");
    expect(
      errorMessage([{ loc: ["body", "title"], msg: "String should have at least 1 character" }], 422),
    ).toBe("title: String should have at least 1 character");
    expect(errorMessage(null, 500)).toBe("Erro 500 no backend.");
  });
});

describe("BoardApi", () => {
  function api(response: Response | Error, token: string | null = "segredo") {
    const fetcher = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    return { client: new BoardApi("http://h:8000/ws", token, fetcher as typeof fetch), fetcher };
  }

  it("envia JSON com o token e devolve a resposta", async () => {
    const { client, fetcher } = api(new Response(JSON.stringify(task(1)), { status: 201 }));
    await expect(client.createTask({ title: "x" })).resolves.toMatchObject({ id: 1 });
    expect(fetcher).toHaveBeenCalledWith("http://h:8000/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer segredo" },
      body: '{"title":"x"}',
    });
  });

  it("aceita 204 sem corpo e não manda token quando não há", async () => {
    const { client, fetcher } = api(new Response(null, { status: 204 }), null);
    await expect(client.deleteSpec(3)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("http://h:8000/api/specs/3", {
      method: "DELETE",
      headers: {},
      body: undefined,
    });
  });

  it("transforma erro do backend e falha de rede em ApiError", async () => {
    const notFound = api(new Response(JSON.stringify({ detail: "Tarefa 5 não existe" }), { status: 404 }));
    await expect(notFound.client.updateTask(5, { status: "done" })).rejects.toThrow(
      new ApiError("Tarefa 5 não existe"),
    );
    const offline = api(new TypeError("fetch failed"));
    await expect(offline.client.spec(1)).rejects.toThrow("Sem conexão com o backend.");
  });
});
