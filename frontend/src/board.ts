/** Tarefas e specs: tipos, filtros das abas e cliente da API. Sem DOM. */

export type TaskStatus = "pending" | "in_progress" | "review" | "blocked" | "done";
export type SpecStatus = "draft" | "approved" | "in_progress" | "implemented";

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  agentId: string | null;
  specId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface SpecSummary {
  id: number;
  title: string;
  status: SpecStatus;
  criteriaCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Spec extends SpecSummary {
  body: string;
  criteria: string[];
}

export interface BoardData {
  tasks: Task[];
  specs: SpecSummary[];
}

export type TaskInput = Partial<
  Pick<Task, "title" | "description" | "status" | "agentId" | "specId">
>;
export type SpecInput = Partial<Pick<Spec, "title" | "status" | "body" | "criteria">>;

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pendente",
  in_progress: "Em andamento",
  review: "Em revisão",
  blocked: "Bloqueada",
  done: "Concluída",
};

export const SPEC_STATUS_LABEL: Record<SpecStatus, string> = {
  draft: "Rascunho",
  approved: "Aprovada",
  in_progress: "Em implementação",
  implemented: "Implementada",
};

export const TASK_STATUSES = Object.keys(TASK_STATUS_LABEL) as TaskStatus[];
export const SPEC_STATUSES = Object.keys(SPEC_STATUS_LABEL) as SpecStatus[];

export type TaskTab = "active" | TaskStatus | "all";
export type SpecTab = "all" | SpecStatus;

export const TASK_TABS: readonly { id: TaskTab; label: string }[] = [
  { id: "active", label: "Ativas" },
  { id: "pending", label: "Pendentes" },
  { id: "in_progress", label: "Em andamento" },
  { id: "review", label: "Em revisão" },
  { id: "blocked", label: "Bloqueadas" },
  { id: "done", label: "Concluídas" },
  { id: "all", label: "Todas" },
];

export const SPEC_TABS: readonly { id: SpecTab; label: string }[] = [
  { id: "all", label: "Todas" },
  { id: "draft", label: "Rascunho" },
  { id: "approved", label: "Aprovada" },
  { id: "in_progress", label: "Em implementação" },
  { id: "implemented", label: "Implementada" },
];

export function taskCode(id: number): string {
  return `T-${String(id).padStart(3, "0")}`;
}

export function specCode(id: number): string {
  return String(id).padStart(3, "0");
}

export function taskInTab(task: Task, tab: TaskTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") return task.status !== "done";
  return task.status === tab;
}

/** Texto sem acento e em minúsculas, para a busca. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function matches(query: string, ...fields: string[]): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const haystack = normalize(fields.join(" "));
  return words.every((word) => haystack.includes(word));
}

/** Tarefas da aba que batem com a busca (código, título ou agente), mais novas primeiro. */
export function filterTasks(
  tasks: readonly Task[],
  tab: TaskTab,
  query: string,
  agentName: (agentId: string) => string,
): Task[] {
  return tasks
    .filter((task) => taskInTab(task, tab))
    .filter((task) =>
      matches(
        query,
        taskCode(task.id),
        task.title,
        task.agentId ? `${task.agentId} ${agentName(task.agentId)}` : "",
      ),
    )
    .sort((a, b) => b.id - a.id);
}

export function countTaskTabs(tasks: readonly Task[]): Record<TaskTab, number> {
  const counts = Object.fromEntries(TASK_TABS.map((tab) => [tab.id, 0])) as Record<
    TaskTab,
    number
  >;
  for (const task of tasks) {
    for (const tab of TASK_TABS) if (taskInTab(task, tab.id)) counts[tab.id]++;
  }
  return counts;
}

/** Specs da aba que batem com a busca (número ou título), mais novas primeiro. */
export function filterSpecs(
  specs: readonly SpecSummary[],
  tab: SpecTab,
  query: string,
): SpecSummary[] {
  return specs
    .filter((spec) => tab === "all" || spec.status === tab)
    .filter((spec) => matches(query, specCode(spec.id), String(spec.id), spec.title))
    .sort((a, b) => b.id - a.id);
}

export function countSpecTabs(specs: readonly SpecSummary[]): Record<SpecTab, number> {
  const counts = Object.fromEntries(SPEC_TABS.map((tab) => [tab.id, 0])) as Record<
    SpecTab,
    number
  >;
  counts.all = specs.length;
  for (const spec of specs) counts[spec.status]++;
  return counts;
}

export function tasksOfSpec(tasks: readonly Task[], specId: number): Task[] {
  return tasks.filter((task) => task.specId === specId).sort((a, b) => a.id - b.id);
}

/** Critérios de aceite digitados um por linha, sem linhas vazias. */
export function parseCriteria(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|CA-?\d+[:.)-]?|\d+[.)])\s*/i, "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- API

export class ApiError extends Error {}

type Fetch = typeof fetch;

export class BoardApi {
  constructor(
    private readonly base: string,
    private readonly token: string | null,
    private readonly fetcher: Fetch = (...args) => fetch(...args),
  ) {}

  createTask(data: TaskInput): Promise<Task> {
    return this.request("POST", "/api/tasks", data) as Promise<Task>;
  }

  updateTask(id: number, data: TaskInput): Promise<Task> {
    return this.request("PATCH", `/api/tasks/${id}`, data) as Promise<Task>;
  }

  async deleteTask(id: number): Promise<void> {
    await this.request("DELETE", `/api/tasks/${id}`);
  }

  spec(id: number): Promise<Spec> {
    return this.request("GET", `/api/specs/${id}`) as Promise<Spec>;
  }

  createSpec(data: SpecInput): Promise<Spec> {
    return this.request("POST", "/api/specs", data) as Promise<Spec>;
  }

  updateSpec(id: number, data: SpecInput): Promise<Spec> {
    return this.request("PATCH", `/api/specs/${id}`, data) as Promise<Spec>;
  }

  async deleteSpec(id: number): Promise<void> {
    await this.request("DELETE", `/api/specs/${id}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.base).toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError("Sem conexão com o backend.");
    }
    if (response.status === 204) return null;
    const data = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    if (!response.ok) throw new ApiError(errorMessage(data?.detail, response.status));
    return data;
  }
}

/** Mensagem legível a partir do `detail` do FastAPI (texto ou lista de erros). */
export function errorMessage(detail: unknown, status: number): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((item: { loc?: unknown[]; msg?: string }) => {
      const field = item.loc?.filter((part) => part !== "body").join(".");
      return field ? `${field}: ${item.msg}` : (item.msg ?? "inválido");
    });
    if (parts.length) return parts.join("; ");
  }
  return `Erro ${status} no backend.`;
}
