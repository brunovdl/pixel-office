/** Janelas de Tarefas e Specs. */

import {
  ApiError,
  SPEC_STATUSES,
  SPEC_STATUS_LABEL,
  SPEC_TABS,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  TASK_TABS,
  countSpecTabs,
  countTaskTabs,
  filterSpecs,
  filterTasks,
  parseCriteria,
  specCode,
  taskCode,
  tasksOfSpec,
  type BoardApi,
  type BoardData,
  type Spec,
  type SpecStatus,
  type SpecTab,
  type Task,
  type TaskInput,
  type TaskStatus,
  type TaskTab,
} from "./board";
import { shirtColor } from "./look";
import { renderMarkdown } from "./markdown";
import type { OfficeState } from "./state";
import { button, el } from "./ui";

const NO_BACKEND = "Tarefas e specs precisam do backend. Abra a página sem ?sim.";

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function agentChip(state: OfficeState, agentId: string | null): HTMLElement {
  const chip = el("span", "tag tag-agent");
  const dot = el("span", "agent-dot");
  const agent = agentId ? state.agents[agentId] : undefined;
  dot.style.background = agent ? shirtColor(agent.seq) : "var(--muted)";
  chip.append(dot, document.createTextNode(agentId ? (agent?.name ?? agentId) : "sem responsável"));
  if (!agentId) chip.classList.add("muted");
  return chip;
}

function statusTag(kind: "task" | "spec", status: TaskStatus | SpecStatus): HTMLElement {
  const label =
    kind === "task"
      ? TASK_STATUS_LABEL[status as TaskStatus]
      : SPEC_STATUS_LABEL[status as SpecStatus];
  return el("span", `tag tag-status ${kind}-${status}`, label.toLowerCase());
}

export function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = el("label", "field");
  wrap.append(el("span", "field-label", label), control);
  return wrap;
}

export function select<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
): HTMLSelectElement {
  const node = el("select", "input");
  for (const option of options) {
    const item = el("option", "", option.label);
    item.value = option.value;
    node.append(item);
  }
  node.value = value;
  return node;
}

/** Botão de excluir em dois cliques, para não apagar por engano. */
export function deleteButton(onConfirm: () => void): HTMLButtonElement {
  const node = button("btn-danger", "Excluir", () => {
    if (node.classList.contains("is-armed")) onConfirm();
    else {
      node.classList.add("is-armed");
      node.textContent = "Confirmar exclusão";
    }
  });
  node.addEventListener("blur", () => {
    node.classList.remove("is-armed");
    node.textContent = "Excluir";
  });
  return node;
}

/** Roda a ação com os botões travados e mostra o erro no formulário. */
export async function submitting(
  form: HTMLElement,
  error: HTMLElement,
  action: () => Promise<void>,
): Promise<void> {
  const controls = [...form.querySelectorAll<HTMLButtonElement>("button")];
  controls.forEach((control) => (control.disabled = true));
  error.textContent = "";
  try {
    await action();
  } catch (exc) {
    error.textContent = exc instanceof ApiError ? exc.message : "Algo deu errado.";
  } finally {
    controls.forEach((control) => (control.disabled = false));
  }
}

/** Abas com contagem, criadas uma vez e só atualizadas (não perdem o foco). */
class Tabs<T extends string> {
  readonly el = el("div", "tabs");
  private readonly buttons = new Map<T, HTMLButtonElement>();

  constructor(
    private readonly tabs: readonly { id: T; label: string }[],
    onPick: (tab: T) => void,
  ) {
    this.el.setAttribute("role", "tablist");
    for (const tab of tabs) {
      const node = button("tab", tab.label, () => onPick(tab.id));
      node.setAttribute("role", "tab");
      this.buttons.set(tab.id, node);
      this.el.append(node);
    }
  }

  update(active: T, counts: Record<T, number>): void {
    for (const tab of this.tabs) {
      const node = this.buttons.get(tab.id)!;
      node.textContent = `${tab.label} (${counts[tab.id]})`;
      node.classList.toggle("is-active", tab.id === active);
      node.setAttribute("aria-selected", String(tab.id === active));
    }
  }
}

function searchInput(placeholder: string, onInput: (query: string) => void): HTMLInputElement {
  const input = el("input", "input search");
  input.type = "search";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/** Esc no formulário cancela a edição em vez de fechar a janela. */
export function cancelOnEscape(form: HTMLElement, cancel: () => void): void {
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    cancel();
  });
}

// ----------------------------------------------------------------- tarefas

export class TasksView {
  private tab: TaskTab = "active";
  private query = "";
  private editing: number | "new" | null = null;
  private board: BoardData = { tasks: [], specs: [] };
  private state: OfficeState | null = null;
  private version = -1;
  private shownKey = "";
  private readonly listView = el("div", "board-view");
  private readonly tabs = new Tabs(TASK_TABS, (tab) => {
    this.tab = tab;
    this.renderList();
  });
  private readonly rows = el("ul", "rows");
  private readonly editor = el("div", "board-view board-editor");

  constructor(
    body: HTMLElement,
    private readonly api: BoardApi | null,
    private readonly openSpec: (specId: number) => void,
  ) {
    if (!api) {
      body.append(el("p", "empty pad", NO_BACKEND));
      return;
    }
    const tools = el("div", "board-tools");
    tools.append(
      searchInput("Buscar por ID, título ou agente", (query) => {
        this.query = query;
        this.renderList();
      }),
      button("btn-primary", "Nova tarefa", () => this.openTask("new")),
    );
    const head = el("div", "board-head");
    head.append(this.tabs.el, tools);
    this.listView.append(head, this.rows);
    this.editor.hidden = true;
    body.append(this.listView, this.editor);
  }

  update(board: BoardData, version: number, state: OfficeState): void {
    this.board = board;
    this.version = version;
    this.state = state;
    if (this.api && this.editing === null) this.renderList();
  }

  openTask(id: number | "new"): void {
    if (!this.api || !this.state) return;
    const task = id === "new" ? null : this.board.tasks.find((t) => t.id === id);
    if (id !== "new" && !task) return;
    this.editing = id;
    this.editor.replaceChildren(this.form(task ?? null));
    this.listView.hidden = true;
    this.editor.hidden = false;
    this.editor.querySelector<HTMLInputElement>("input")?.focus();
  }

  private closeEditor(): void {
    this.editing = null;
    this.editor.hidden = true;
    this.editor.replaceChildren();
    this.listView.hidden = false;
    this.shownKey = "";
    this.renderList();
  }

  private agentName = (agentId: string): string =>
    this.state?.agents[agentId]?.name ?? agentId;

  private renderList(): void {
    const state = this.state;
    if (!state) return;
    const agents = state.order.map((id) => `${id}:${state.agents[id]?.name}`).join("|");
    const key = `${this.version}#${this.tab}#${this.query}#${agents}`;
    if (key === this.shownKey) return;
    this.shownKey = key;

    this.tabs.update(this.tab, countTaskTabs(this.board.tasks));
    const tasks = filterTasks(this.board.tasks, this.tab, this.query, this.agentName);
    if (tasks.length === 0) {
      this.rows.replaceChildren(el("li", "empty", "Nenhuma tarefa neste status."));
      return;
    }
    const specs = new Map(this.board.specs.map((spec) => [spec.id, spec]));
    this.rows.replaceChildren(
      ...tasks.map((task) => {
        const row = el("li", `row status-${task.status}`);
        const main = button("row-main", "", () => this.openTask(task.id));
        main.title = task.description || task.title;
        main.append(el("span", "row-code", taskCode(task.id)), el("span", "row-title", task.title));
        const tags = el("span", "row-tags");
        const spec = task.specId === null ? undefined : specs.get(task.specId);
        if (spec) {
          const link = button("tag tag-link", `spec ${specCode(spec.id)}`, () =>
            this.openSpec(spec.id),
          );
          link.title = spec.title;
          tags.append(link);
        }
        tags.append(agentChip(state, task.agentId), statusTag("task", task.status));
        row.append(main, tags);
        return row;
      }),
    );
  }

  private form(task: Task | null): HTMLElement {
    const state = this.state!;
    const form = el("form", "form");
    const title = el("input", "input");
    title.required = true;
    title.maxLength = 200;
    title.value = task?.title ?? "";
    const description = el("textarea", "input");
    description.rows = 6;
    description.maxLength = 20000;
    description.value = task?.description ?? "";

    const status = select(
      TASK_STATUSES.map((value) => ({ value, label: TASK_STATUS_LABEL[value] })),
      task?.status ?? "pending",
    );
    const agentIds = [...state.order];
    if (task?.agentId && !agentIds.includes(task.agentId)) agentIds.push(task.agentId);
    const agent = select(
      [
        { value: "", label: "Sem responsável" },
        ...agentIds.map((id) => ({ value: id, label: this.agentName(id) })),
      ],
      task?.agentId ?? "",
    );
    const spec = select(
      [
        { value: "", label: "Sem spec" },
        ...[...this.board.specs]
          .sort((a, b) => b.id - a.id)
          .map((s) => ({ value: String(s.id), label: `${specCode(s.id)} · ${s.title}` })),
      ],
      task?.specId ? String(task.specId) : "",
    );

    const heading = el("div", "form-head");
    heading.append(
      button("link", "← Voltar", () => this.closeEditor()),
      el("strong", "", task ? `${taskCode(task.id)} · editar tarefa` : "Nova tarefa"),
    );
    const grid = el("div", "form-grid");
    grid.append(field("Status", status), field("Responsável", agent), field("Spec", spec));
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    const actions = el("div", "form-actions");
    const save = el("button", "btn-primary", task ? "Salvar" : "Criar tarefa");
    save.type = "submit";
    actions.append(save, button("", "Cancelar", () => this.closeEditor()));
    if (task) {
      actions.append(
        deleteButton(() =>
          submitting(form, error, async () => {
            await this.api!.deleteTask(task.id);
            this.closeEditor();
          }),
        ),
      );
    }

    form.append(heading, field("Título", title), field("Descrição", description), grid);
    if (task) {
      form.append(
        el(
          "p",
          "muted",
          `Criada em ${formatDateTime(task.createdAt)} · atualizada em ${formatDateTime(task.updatedAt)}`,
        ),
      );
    }
    form.append(error, actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data: TaskInput = {
        title: title.value.trim(),
        description: description.value,
        status: status.value as TaskStatus,
        agentId: agent.value || null,
        specId: spec.value ? Number(spec.value) : null,
      };
      void submitting(form, error, async () => {
        if (task) await this.api!.updateTask(task.id, data);
        else await this.api!.createTask(data);
        this.closeEditor();
      });
    });
    cancelOnEscape(form, () => this.closeEditor());
    return form;
  }
}

// ------------------------------------------------------------------- specs

type SpecMode = { kind: "list" } | { kind: "view"; id: number } | { kind: "edit"; id: number | null };

export class SpecsView {
  private tab: SpecTab = "all";
  private query = "";
  private mode: SpecMode = { kind: "list" };
  private board: BoardData = { tasks: [], specs: [] };
  private state: OfficeState | null = null;
  private version = -1;
  private shownKey = "";
  /** Spec aberta, carregada da API (a lista só tem o resumo). */
  private loaded: Spec | null = null;
  private loadToken = 0;
  private readonly listView = el("div", "board-view");
  private readonly tabs = new Tabs(SPEC_TABS, (tab) => {
    this.tab = tab;
    this.renderList();
  });
  private readonly rows = el("ul", "rows");
  private readonly detail = el("div", "board-view board-editor");

  constructor(
    body: HTMLElement,
    private readonly api: BoardApi | null,
    private readonly openTask: (taskId: number) => void,
  ) {
    if (!api) {
      body.append(el("p", "empty pad", NO_BACKEND));
      return;
    }
    const tools = el("div", "board-tools");
    tools.append(
      searchInput("Buscar por número ou título", (query) => {
        this.query = query;
        this.renderList();
      }),
      button("btn-primary", "Nova spec", () => this.edit(null)),
    );
    const head = el("div", "board-head");
    head.append(this.tabs.el, tools);
    this.listView.append(head, this.rows);
    this.detail.hidden = true;
    body.append(this.listView, this.detail);
  }

  update(board: BoardData, version: number, state: OfficeState): void {
    const changed = version !== this.version;
    this.board = board;
    this.version = version;
    this.state = state;
    if (!this.api) return;
    if (this.mode.kind === "list") this.renderList();
    else if (this.mode.kind === "view" && changed) this.refreshView(this.mode.id);
  }

  openSpec(id: number): void {
    if (!this.api) return;
    this.mode = { kind: "view", id };
    this.showDetail(el("p", "muted", "Carregando…"));
    void this.load(id);
  }

  private backToList(): void {
    this.mode = { kind: "list" };
    this.loaded = null;
    this.detail.hidden = true;
    this.detail.replaceChildren();
    this.listView.hidden = false;
    this.shownKey = "";
    this.renderList();
  }

  private showDetail(content: HTMLElement): void {
    this.detail.replaceChildren(content);
    this.listView.hidden = true;
    this.detail.hidden = false;
  }

  private renderList(): void {
    const key = `${this.version}#${this.tab}#${this.query}`;
    if (key === this.shownKey) return;
    this.shownKey = key;

    this.tabs.update(this.tab, countSpecTabs(this.board.specs));
    const specs = filterSpecs(this.board.specs, this.tab, this.query);
    if (specs.length === 0) {
      this.rows.replaceChildren(el("li", "empty", "Nenhuma spec neste status."));
      return;
    }
    this.rows.replaceChildren(
      ...specs.map((spec) => {
        const row = el("li", `row spec-row spec-${spec.status}`);
        const main = button("row-main", "", () => this.openSpec(spec.id));
        main.append(el("span", "row-code", specCode(spec.id)), el("span", "row-title", spec.title));
        const tags = el("span", "row-tags");
        tags.append(el("span", "tag tag-criteria", `${spec.criteriaCount} CAs`));
        const count = tasksOfSpec(this.board.tasks, spec.id).length;
        if (count > 0) {
          tags.append(el("span", "tag tag-tasks", `${count} ${count === 1 ? "tarefa" : "tarefas"}`));
        }
        tags.append(statusTag("spec", spec.status));
        row.append(main, tags);
        return row;
      }),
    );
  }

  private async load(id: number): Promise<void> {
    const token = ++this.loadToken;
    try {
      const spec = await this.api!.spec(id);
      if (token !== this.loadToken || this.mode.kind !== "view" || this.mode.id !== id) return;
      this.loaded = spec;
      this.showDetail(this.view(spec));
    } catch (exc) {
      if (token !== this.loadToken) return;
      const box = el("div");
      box.append(
        button("link", "← Voltar", () => this.backToList()),
        el("p", "form-error", exc instanceof ApiError ? exc.message : "Não foi possível abrir."),
      );
      this.showDetail(box);
    }
  }

  /** Recarrega a spec aberta se ela mudou ou sumiu no quadro. */
  private refreshView(id: number): void {
    const summary = this.board.specs.find((spec) => spec.id === id);
    if (!summary) {
      this.backToList();
      return;
    }
    const loaded = this.loaded;
    if (!loaded || loaded.id !== id) return;
    if (summary.updatedAt !== loaded.updatedAt) void this.load(id);
    else this.showDetail(this.view(loaded));
  }

  private view(spec: Spec): HTMLElement {
    const root = el("article", "spec-view");
    const head = el("div", "form-head");
    head.append(
      button("link", "← Voltar", () => this.backToList()),
      el("strong", "spec-title", `${specCode(spec.id)} · ${spec.title}`),
      statusTag("spec", spec.status),
    );
    const actions = el("div", "spec-actions");
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    if (spec.status === "draft") {
      actions.append(
        button("btn-primary", "Aprovar", () =>
          submitting(root, error, async () => {
            await this.api!.updateSpec(spec.id, { status: "approved" });
          }),
        ),
      );
    }
    actions.append(button("", "Editar", () => this.edit(spec)));
    head.append(actions);
    root.append(head, error, el("p", "muted", `Atualizada em ${formatDateTime(spec.updatedAt)}`));

    root.append(el("h3", "section-title", `Critérios de aceite (${spec.criteria.length})`));
    if (spec.criteria.length) {
      const list = el("ol", "criteria");
      spec.criteria.forEach((criterion, index) => {
        const item = el("li");
        item.append(el("span", "criteria-code", `CA-${index + 1}`), document.createTextNode(criterion));
        list.append(item);
      });
      root.append(list);
    } else root.append(el("p", "muted", "Nenhum critério ainda."));

    const tasks = tasksOfSpec(this.board.tasks, spec.id);
    root.append(el("h3", "section-title", `Tarefas (${tasks.length})`));
    if (tasks.length) {
      const list = el("ul", "rows");
      for (const task of tasks) {
        const row = el("li", `row status-${task.status}`);
        const main = button("row-main", "", () => this.openTask(task.id));
        main.append(el("span", "row-code", taskCode(task.id)), el("span", "row-title", task.title));
        const tags = el("span", "row-tags");
        tags.append(agentChip(this.state!, task.agentId), statusTag("task", task.status));
        row.append(main, tags);
        list.append(row);
      }
      root.append(list);
    } else root.append(el("p", "muted", "Nenhuma tarefa ligada a esta spec."));

    root.append(el("h3", "section-title", "Texto"));
    root.append(spec.body.trim() ? renderMarkdown(spec.body) : el("p", "muted", "Sem texto."));
    return root;
  }

  private edit(spec: Spec | null): void {
    this.mode = { kind: "edit", id: spec?.id ?? null };
    const form = el("form", "form");
    const title = el("input", "input");
    title.required = true;
    title.maxLength = 200;
    title.value = spec?.title ?? "";
    const status = select(
      SPEC_STATUSES.map((value) => ({ value, label: SPEC_STATUS_LABEL[value] })),
      spec?.status ?? "draft",
    );
    const criteria = el("textarea", "input");
    criteria.rows = 6;
    criteria.placeholder = "Um critério por linha";
    criteria.value = spec?.criteria.join("\n") ?? "";
    const body = el("textarea", "input input-code");
    body.rows = 14;
    body.placeholder = "## Objetivo\n\nTexto em markdown";
    body.value = spec?.body ?? "";

    const cancel = () => (spec ? this.openSpec(spec.id) : this.backToList());
    const heading = el("div", "form-head");
    heading.append(
      button("link", "← Voltar", cancel),
      el("strong", "", spec ? `${specCode(spec.id)} · editar spec` : "Nova spec"),
    );
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    const actions = el("div", "form-actions");
    const save = el("button", "btn-primary", spec ? "Salvar" : "Criar spec");
    save.type = "submit";
    actions.append(save, button("", "Cancelar", cancel));
    if (spec) {
      actions.append(
        deleteButton(() =>
          submitting(form, error, async () => {
            await this.api!.deleteSpec(spec.id);
            this.backToList();
          }),
        ),
      );
    }

    const grid = el("div", "form-grid");
    grid.append(field("Status", status));
    form.append(
      heading,
      field("Título", title),
      grid,
      field("Critérios de aceite (um por linha)", criteria),
      field("Texto (markdown)", body),
    );
    if (spec) form.append(el("p", "muted", "Excluir a spec mantém as tarefas, sem spec."));
    form.append(error, actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = {
        title: title.value.trim(),
        status: status.value as SpecStatus,
        criteria: parseCriteria(criteria.value),
        body: body.value,
      };
      void submitting(form, error, async () => {
        const saved = spec
          ? await this.api!.updateSpec(spec.id, data)
          : await this.api!.createSpec(data);
        this.openSpec(saved.id);
      });
    });
    cancelOnEscape(form, cancel);
    this.showDetail(form);
    title.focus();
  }
}
