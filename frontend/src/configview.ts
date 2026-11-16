/** Janela de configurações: escritório, chaves de API, MCPs e agentes. */

import {
  cancelOnEscape,
  deleteButton,
  field,
  formatDateTime,
  select,
  submitting,
} from "./boardviews";
import {
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  PROMPT_FILES,
  isSlug,
  parseArgs,
  secretPayload,
  slugify,
  type AgentConfig,
  type ConfigApi,
  type CredentialId,
  type PermissionMode,
  type Runtime,
  type McpConfig,
  type PublicConfig,
  TOOLS,
  toolReady,
  type ToolId,
  type SecretRow,
} from "./config";
import { shirtColor } from "./look";
import type { OfficeState } from "./state";
import { button, el } from "./ui";

type Section = "office" | "runner" | "keys" | "mcps" | "agents";

const SECTIONS: readonly { id: Section; label: string; icon: string }[] = [
  { id: "office", label: "Escritório", icon: "▣" },
  { id: "runner", label: "Execução", icon: "▶" },
  { id: "keys", label: "Credenciais", icon: "⚿" },
  { id: "mcps", label: "MCPs", icon: "⛁" },
  { id: "agents", label: "Agentes", icon: "☺" },
];

const NOT_WIRED =
  "Agentes com Claude Code rodam de verdade no servidor (veja Execução). Cursor e Antigravity ainda não têm integração, e agentes sem ferramenta só aparecem no modo simulado.";

function note(text: string): HTMLElement {
  return el("p", "cfg-note", text);
}

function checkbox(label: string, checked: boolean): [HTMLLabelElement, HTMLInputElement] {
  const wrap = el("label", "check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  wrap.append(input, document.createTextNode(label));
  return [wrap, input];
}

function textInput(value: string, maxLength: number, placeholder = ""): HTMLInputElement {
  const input = el("input", "input");
  input.value = value;
  input.maxLength = maxLength;
  input.placeholder = placeholder;
  return input;
}

function textArea(value: string, rows: number, placeholder = "", code = false): HTMLTextAreaElement {
  const area = el("textarea", code ? "input input-code" : "input");
  area.value = value;
  area.rows = rows;
  area.placeholder = placeholder;
  return area;
}

function formShell(
  title: string,
  onBack: () => void,
): { form: HTMLFormElement; error: HTMLElement; actions: HTMLElement } {
  const form = el("form", "form");
  const head = el("div", "form-head");
  head.append(button("link", "← Voltar", onBack), el("strong", "", title));
  const error = el("p", "form-error");
  error.setAttribute("role", "alert");
  const actions = el("div", "form-actions");
  form.append(head);
  cancelOnEscape(form, onBack);
  return { form, error, actions };
}

export class ConfigView {
  private section: Section = "office";
  private config: PublicConfig | null = null;
  private state: OfficeState | null = null;
  private version = -1;
  private readonly nav = el("nav", "cfg-nav");
  private readonly navButtons = new Map<Section, HTMLButtonElement>();
  private readonly panes = new Map<Section, HTMLElement>();
  private readonly office: OfficePane;
  private readonly runner: RunnerPane;
  private readonly keys: KeysPane;
  private readonly mcps: McpsPane;
  private readonly agents: AgentsPane;

  constructor(body: HTMLElement, api: ConfigApi | null) {
    if (!api) {
      body.append(el("p", "empty pad", "As configurações precisam do backend. Abra a página sem ?sim."));
      this.office = this.runner = this.keys = this.mcps = this.agents = null as never;
      return;
    }
    this.nav.setAttribute("aria-label", "Seções");
    for (const section of SECTIONS) {
      const node = button("cfg-tab", "", () => this.show(section.id));
      node.append(el("span", "cfg-tab-icon", section.icon), document.createTextNode(section.label));
      this.navButtons.set(section.id, node);
      this.nav.append(node);
    }
    this.office = new OfficePane(api);
    this.runner = new RunnerPane(api);
    this.keys = new KeysPane(api);
    this.mcps = new McpsPane(api);
    this.agents = new AgentsPane(api);
    const content = el("div", "cfg-content");
    for (const [id, pane] of [
      ["office", this.office.el],
      ["runner", this.runner.el],
      ["keys", this.keys.el],
      ["mcps", this.mcps.el],
      ["agents", this.agents.el],
    ] as const) {
      this.panes.set(id, pane);
      content.append(pane);
    }
    body.append(this.nav, content);
    this.show("office");
  }

  update(config: PublicConfig, version: number, state: OfficeState): void {
    if (!this.office) return;
    const changed = version !== this.version;
    this.config = config;
    this.state = state;
    this.version = version;
    if (changed) this.refresh();
  }

  private show(section: Section): void {
    this.section = section;
    for (const [id, node] of this.navButtons) {
      node.classList.toggle("is-active", id === section);
      node.setAttribute("aria-current", String(id === section));
    }
    for (const [id, pane] of this.panes) pane.hidden = id !== section;
    this.refresh();
  }

  private refresh(): void {
    const config = this.config;
    if (!config) return;
    if (this.section === "office") this.office.update(config, this.version);
    if (this.section === "runner") this.runner.update(config, this.version);
    if (this.section === "keys") this.keys.update(config);
    if (this.section === "mcps") this.mcps.update(config, this.version);
    if (this.section === "agents") this.agents.update(config, this.version, this.state);
  }
}

// --------------------------------------------------------------- escritório

class OfficePane {
  readonly el = el("section", "cfg-pane");
  private readonly logoBox = el("div", "logo-drop");
  private readonly logoPreview = el("img", "logo-preview");
  private readonly logoEmpty = el("span", "muted", "Sem logo");
  private readonly logoError = el("p", "form-error");
  private readonly removeLogo: HTMLButtonElement;
  private readonly formBox = el("div");
  /** Fora do formulário: a atualização ao vivo redesenha o formulário depois de salvar. */
  private readonly saved = el("p", "muted cfg-saved");
  private dirty = false;
  private shownVersion = -1;

  constructor(private readonly api: ConfigApi) {
    this.logoError.setAttribute("role", "alert");
    this.logoPreview.alt = "Logo do escritório";
    const file = el("input");
    file.type = "file";
    file.accept = LOGO_TYPES.join(",");
    file.hidden = true;
    file.addEventListener("change", () => {
      if (file.files?.[0]) void this.upload(file.files[0]);
      file.value = "";
    });
    const pick = button("btn-primary", "Enviar logo", () => file.click());
    this.removeLogo = button("btn-danger", "Remover", () => {
      void submitting(this.el, this.logoError, () => this.api.deleteLogo());
    });

    this.logoBox.append(this.logoPreview, this.logoEmpty);
    this.logoBox.title = "Arraste uma imagem para cá";
    this.logoBox.addEventListener("dragover", (event) => {
      event.preventDefault();
      this.logoBox.classList.add("is-over");
    });
    this.logoBox.addEventListener("dragleave", () => this.logoBox.classList.remove("is-over"));
    this.logoBox.addEventListener("drop", (event) => {
      event.preventDefault();
      this.logoBox.classList.remove("is-over");
      const dropped = event.dataTransfer?.files[0];
      if (dropped) void this.upload(dropped);
    });

    const logoActions = el("div", "form-actions");
    logoActions.append(pick, this.removeLogo, file);
    const logoSection = el("div", "logo-section");
    const logoText = el("div", "logo-text");
    logoText.append(
      el("strong", "", "Logo"),
      el("p", "muted", "PNG, JPEG, WEBP ou GIF, até 2 MB. Aparece no topo e num quadro na parede do escritório."),
      logoActions,
      this.logoError,
    );
    logoSection.append(this.logoBox, logoText);
    this.saved.setAttribute("role", "status");
    this.el.append(el("h3", "cfg-title", "Escritório"), logoSection, this.formBox, this.saved);
  }

  update(config: PublicConfig, version: number): void {
    const logo = config.office.logo;
    this.logoPreview.hidden = !logo;
    this.logoEmpty.hidden = Boolean(logo);
    this.removeLogo.hidden = !logo;
    if (logo) this.logoPreview.src = this.api.logoUrl(logo.updatedAt);
    else this.logoPreview.removeAttribute("src");

    // Não apaga o que o usuário está digitando por causa de uma mudança vinda de fora.
    if (version === this.shownVersion || this.dirty) return;
    this.shownVersion = version;
    this.formBox.replaceChildren(this.form(config));
  }

  private async upload(file: File): Promise<void> {
    this.logoError.textContent = "";
    if (!LOGO_TYPES.includes(file.type)) {
      this.logoError.textContent = "Envie a logo em PNG, JPEG, WEBP ou GIF.";
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      this.logoError.textContent = "A logo passa de 2 MB.";
      return;
    }
    await submitting(this.el, this.logoError, async () => {
      await this.api.uploadLogo(file);
    });
  }

  private form(config: PublicConfig): HTMLElement {
    const form = el("form", "form");
    const name = textInput(config.office.name, 80);
    name.required = true;
    const prompt = textArea(config.office.masterPrompt, 14, "# Instruções do projeto", true);
    const files = el("div", "checks");
    const boxes = PROMPT_FILES.map((file) => {
      const [label, input] = checkbox(file, config.office.promptFiles.includes(file));
      files.append(label);
      return [file, input] as const;
    });
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    const save = el("button", "btn-primary", "Salvar");
    save.type = "submit";
    const actions = el("div", "form-actions");
    actions.append(save);

    form.append(
      field("Nome do escritório", name),
      field("Prompt mestre", prompt),
      el("span", "field-label", "Publicar o prompt mestre como"),
      files,
      note(
        "Cada ferramenta lê um arquivo: Claude Code lê CLAUDE.md, Codex e outros leem AGENTS.md, Gemini lê GEMINI.md. Quando o harness estiver ligado a um repositório, o texto vira esses arquivos.",
      ),
      error,
      actions,
    );
    form.addEventListener("input", () => {
      this.dirty = true;
      this.saved.textContent = "";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitting(form, error, async () => {
        await this.api.saveOffice({
          name: name.value.trim(),
          masterPrompt: prompt.value,
          promptFiles: boxes.filter(([, input]) => input.checked).map(([file]) => file),
        });
        this.dirty = false;
        this.saved.textContent = "Salvo.";
      });
    });
    return form;
  }
}

// ----------------------------------------------------------------- execução

const PERMISSIONS: readonly { value: PermissionMode; label: string; help: string }[] = [
  {
    value: "acceptEdits",
    label: "Só editar arquivos",
    help: "Edita arquivos e roda comandos de leitura. Outros comandos (testes, instalação) são recusados, porque não há ninguém para aprovar.",
  },
  {
    value: "auto",
    label: "Automático",
    help: "Um classificador do Claude Code aprova ou recusa cada ação. Pode não estar disponível em todos os planos.",
  },
  {
    value: "bypassPermissions",
    label: "Liberar tudo",
    help: "Roda qualquer comando sem pedir. Use só num servidor isolado, sem outros segredos além dos do próprio projeto.",
  },
];

class RunnerPane {
  readonly el = el("section", "cfg-pane");
  private readonly statusBox = el("div", "runtime");
  private readonly formBox = el("div");
  private readonly saved = el("p", "muted cfg-saved");
  private dirty = false;
  private shownVersion = -1;

  constructor(private readonly api: ConfigApi) {
    this.saved.setAttribute("role", "status");
    this.el.append(
      el("h3", "cfg-title", "Execução no servidor"),
      note(
        "Agentes cuja ferramenta é o Claude Code pegam a tarefa pendente mais antiga atribuída a eles, rodam na pasta do projeto e devolvem a tarefa em revisão com um resumo, ou bloqueada com o motivo. Mover a tarefa para outro status interrompe a execução.",
      ),
      this.statusBox,
      this.formBox,
      this.saved,
    );
  }

  update(config: PublicConfig, version: number): void {
    void this.loadStatus();
    if (version === this.shownVersion || this.dirty) return;
    this.shownVersion = version;
    this.formBox.replaceChildren(this.form(config));
  }

  private async loadStatus(): Promise<void> {
    let runtime: Runtime;
    try {
      runtime = await this.api.runtime();
    } catch {
      this.statusBox.replaceChildren(el("p", "form-error", "Não foi possível ler a situação do servidor."));
      return;
    }
    const line = (ok: boolean, text: string) => el("li", ok ? "is-ok" : "is-bad", `${ok ? "✓" : "✗"} ${text}`);
    const list = el("ul", "runtime-list");
    if (!runtime.executor) {
      list.append(line(false, "Executor desligado neste servidor."));
    } else {
      const claude = runtime.tools.claude_code;
      list.append(
        line(
          Boolean(claude?.installed),
          claude?.installed
            ? `Claude Code instalado: ${claude.version}`
            : `Claude Code não encontrado (comando ${claude?.command ?? "claude"}). Instale com npm install -g @anthropic-ai/claude-code.`,
        ),
      );
      const workspace = runtime.workspace;
      if (!workspace?.path) list.append(line(false, "Pasta do projeto não definida."));
      else if (!workspace.exists) list.append(line(false, `A pasta não existe: ${workspace.path}`));
      else {
        list.append(line(true, `Pasta do projeto: ${workspace.path}`));
        if (!workspace.git) list.append(line(false, "A pasta não é um repositório git; as mudanças não terão histórico."));
      }
      const running = runtime.running.length;
      list.append(el("li", "muted", running ? `${running} execução em andamento.` : "Nenhuma execução em andamento."));
    }
    this.statusBox.replaceChildren(list);
  }

  private form(config: PublicConfig): HTMLElement {
    const runner = config.runner;
    const form = el("form", "form");
    const workspace = textInput(runner.workspaceDir, 1000, "/caminho/do/projeto");
    const permission = select(
      PERMISSIONS.map((p) => ({ value: p.value, label: p.label })),
      runner.permissionMode,
    );
    const help = el("p", "cfg-note");
    const syncHelp = () => {
      const chosen = PERMISSIONS.find((p) => p.value === permission.value);
      help.textContent = chosen?.help ?? "";
      help.classList.toggle("is-warn", permission.value === "bypassPermissions");
    };
    permission.addEventListener("change", syncHelp);
    syncHelp();

    const number = (value: number | null, min: number, max: number, placeholder = "") => {
      const input = el("input", "input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.placeholder = placeholder;
      input.value = value === null ? "" : String(value);
      return input;
    };
    const timeout = number(runner.timeoutMinutes, 1, 480);
    timeout.required = true;
    const maxTurns = number(runner.maxTurns, 1, 1000, "sem limite");
    const parallel = number(runner.maxParallel, 1, 8);
    parallel.required = true;

    const grid = el("div", "form-grid");
    grid.append(
      field("Tempo limite por tarefa (min)", timeout),
      field("Máximo de turnos", maxTurns),
      field("Execuções ao mesmo tempo", parallel),
    );
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    const save = el("button", "btn-primary", "Salvar");
    save.type = "submit";
    const actions = el("div", "form-actions");
    actions.append(save);

    form.append(
      field("Pasta do projeto no servidor", workspace),
      note("O repositório do produto, já clonado no servidor. Os agentes trabalham direto nesta pasta."),
      field("Permissões do Claude Code", permission),
      help,
      grid,
      note(
        "Com mais de uma execução ao mesmo tempo, os agentes mexem na mesma pasta e podem se atrapalhar. Deixe 1 até haver uma cópia por agente.",
      ),
      error,
      actions,
    );
    form.addEventListener("input", () => {
      this.dirty = true;
      this.saved.textContent = "";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitting(form, error, async () => {
        await this.api.saveRunner({
          workspaceDir: workspace.value.trim(),
          permissionMode: permission.value as PermissionMode,
          timeoutMinutes: Number(timeout.value),
          maxTurns: maxTurns.value ? Number(maxTurns.value) : null,
          maxParallel: Number(parallel.value),
        });
        this.dirty = false;
        this.saved.textContent = "Salvo.";
        void this.loadStatus();
      });
    });
    return form;
  }
}

// ------------------------------------------------------------ chaves de API

class KeysPane {
  readonly el = el("section", "cfg-pane");
  private readonly list = el("div", "key-list");
  private readonly rows = new Map<CredentialId, { status: HTMLElement; remove: HTMLButtonElement }>();

  constructor(private readonly api: ConfigApi) {
    this.el.append(
      el("h3", "cfg-title", "Credenciais das ferramentas"),
      note(
        "Cada ferramenta lê sua credencial de uma variável de ambiente. Para o Claude Code basta uma das duas. O Antigravity também pode usar o login de uma sessão interativa. Tudo fica no servidor, criptografado, e nunca volta para o navegador: aqui aparecem só os últimos caracteres.",
      ),
      this.list,
      note(NOT_WIRED),
    );
  }

  update(config: PublicConfig): void {
    for (const credential of config.credentials) {
      let row = this.rows.get(credential.id);
      if (!row) row = this.addRow(credential.id, credential.label, credential.env);
      row.status.textContent = credential.configured
        ? `configurada ${credential.hint ?? ""}${credential.updatedAt ? ` · ${formatDateTime(credential.updatedAt)}` : ""}`
        : "não configurada";
      row.status.classList.toggle("is-ok", credential.configured);
      row.remove.hidden = !credential.configured;
    }
  }

  private addRow(
    id: CredentialId,
    label: string,
    env: string,
  ): { status: HTMLElement; remove: HTMLButtonElement } {
    const form = el("form", "key-row");
    const head = el("div", "key-head");
    const status = el("span", "key-status");
    const title = el("span", "key-title");
    title.append(el("strong", "", label), el("code", "key-env", env));
    head.append(title, status);
    const input = el("input", "input");
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "Cole a credencial aqui";
    input.setAttribute("aria-label", `Chave de ${label}`);
    const save = el("button", "btn-primary", "Salvar");
    save.type = "submit";
    const error = el("p", "form-error");
    error.setAttribute("role", "alert");
    const remove = deleteButton(() =>
      submitting(form, error, async () => {
        await this.api.deleteKey(id);
      }),
    );
    remove.textContent = "Remover";
    remove.addEventListener("blur", () => (remove.textContent = "Remover"));
    const line = el("div", "key-line");
    line.append(input, save, remove);
    form.append(head, line, error);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      void submitting(form, error, async () => {
        await this.api.setKey(id, value);
        input.value = "";
      });
    });
    this.list.append(form);
    const row = { status, remove };
    this.rows.set(id, row);
    return row;
  }
}

// ---------------------------------------------------------------- segredos

/** Editor de pares nome/valor em que o valor salvo nunca aparece. */
class SecretsEditor {
  readonly el = el("div", "secrets");
  private readonly rows = el("div", "secret-rows");
  private readonly entries: { name: HTMLInputElement; value: HTMLInputElement; kept: boolean; row: HTMLElement }[] = [];

  constructor(saved: readonly { name: string; hint: string }[], addLabel: string) {
    for (const item of saved) this.add(item.name, item.hint);
    this.el.append(
      this.rows,
      button("link", `+ ${addLabel}`, () => this.add("", null).focus()),
    );
  }

  values(): SecretRow[] {
    return this.entries.map((entry) => ({
      name: entry.name.value,
      value: entry.value.value,
      kept: entry.kept,
    }));
  }

  private add(name: string, hint: string | null): HTMLInputElement {
    const row = el("div", "secret-row");
    const nameInput = textInput(name, 64, "NOME");
    nameInput.setAttribute("aria-label", "Nome");
    const value = el("input", "input");
    value.type = "password";
    value.autocomplete = "off";
    value.placeholder = hint ? `salvo ${hint} (vazio mantém)` : "valor";
    value.setAttribute("aria-label", "Valor");
    const entry = { name: nameInput, value, kept: hint !== null, row };
    const remove = button("btn-icon", "✕", () => {
      this.entries.splice(this.entries.indexOf(entry), 1);
      row.remove();
    });
    remove.title = "Remover";
    remove.setAttribute("aria-label", "Remover");
    row.append(nameInput, value, remove);
    this.rows.append(row);
    this.entries.push(entry);
    return nameInput;
  }
}

// -------------------------------------------------------------------- MCPs

class McpsPane {
  readonly el = el("section", "cfg-pane");
  private readonly list = el("ul", "rows cfg-rows");
  private readonly listView = el("div");
  private readonly editor = el("div");
  private editing = false;
  private config: PublicConfig | null = null;
  private shownVersion = -1;

  constructor(private readonly api: ConfigApi) {
    const head = el("div", "cfg-head");
    head.append(el("h3", "cfg-title", "MCPs"), button("btn-primary", "Novo MCP", () => this.open(null)));
    this.listView.append(
      head,
      note("Servidores MCP que os agentes podem usar. Em cada agente você escolhe quais ele acessa."),
      this.list,
    );
    this.editor.hidden = true;
    this.el.append(this.listView, this.editor);
  }

  update(config: PublicConfig, version: number): void {
    this.config = config;
    if (this.editing || version === this.shownVersion) return;
    this.shownVersion = version;
    this.renderList();
  }

  private renderList(): void {
    const config = this.config!;
    if (config.mcps.length === 0) {
      this.list.replaceChildren(el("li", "empty", "Nenhum MCP configurado."));
      return;
    }
    this.list.replaceChildren(
      ...config.mcps.map((mcp) => {
        const users = config.agents.filter((agent) => agent.mcps.includes(mcp.id)).length;
        const row = el("li", `row ${mcp.enabled ? "status-in_progress" : ""}`);
        const main = button("row-main", "", () => this.open(mcp));
        main.append(el("span", "row-code", mcp.id), el("span", "row-title", mcp.name));
        const tags = el("span", "row-tags");
        tags.append(el("span", "tag", mcp.transport));
        const secrets = mcp.env.length + mcp.headers.length;
        if (secrets) tags.append(el("span", "tag tag-criteria", `${secrets} ${secrets === 1 ? "segredo" : "segredos"}`));
        tags.append(el("span", "tag tag-tasks", `${users} ${users === 1 ? "agente" : "agentes"}`));
        tags.append(el("span", `tag tag-status ${mcp.enabled ? "task-done" : ""}`, mcp.enabled ? "ativo" : "inativo"));
        row.append(main, tags);
        return row;
      }),
    );
  }

  private close(): void {
    this.editing = false;
    this.editor.hidden = true;
    this.editor.replaceChildren();
    this.listView.hidden = false;
    this.shownVersion = -1;
    if (this.config) this.update(this.config, -2);
  }

  private open(mcp: McpConfig | null): void {
    this.editing = true;
    const { form, error, actions } = formShell(mcp ? `MCP ${mcp.id}` : "Novo MCP", () => this.close());
    const name = textInput(mcp?.name ?? "", 80, "GitHub");
    name.required = true;
    const id = textInput(mcp?.id ?? "", 32, "github");
    id.disabled = mcp !== null;
    let idTouched = mcp !== null;
    id.addEventListener("input", () => (idTouched = true));
    name.addEventListener("input", () => {
      if (!idTouched) id.value = slugify(name.value);
    });
    const transport = select(
      [
        { value: "stdio", label: "Comando local (stdio)" },
        { value: "http", label: "Servidor remoto (http)" },
      ],
      mcp?.transport ?? "stdio",
    );
    const command = textInput(mcp?.command ?? "", 500, "npx");
    const args = textArea(mcp?.args.join("\n") ?? "", 3, "-y\n@modelcontextprotocol/server-github", true);
    const url = textInput(mcp?.url ?? "", 2000, "https://exemplo.com/mcp");
    const env = new SecretsEditor(mcp?.env ?? [], "Adicionar variável");
    const headers = new SecretsEditor(mcp?.headers ?? [], "Adicionar cabeçalho");
    const [enabledLabel, enabled] = checkbox("Ativo", mcp?.enabled ?? true);

    const stdioFields = el("div", "form");
    stdioFields.append(
      field("Comando", command),
      field("Argumentos (um por linha)", args),
      el("span", "field-label", "Variáveis de ambiente (valores secretos)"),
      env.el,
    );
    const httpFields = el("div", "form");
    httpFields.append(
      field("URL", url),
      el("span", "field-label", "Cabeçalhos HTTP (valores secretos)"),
      headers.el,
    );
    const syncTransport = () => {
      stdioFields.hidden = transport.value !== "stdio";
      httpFields.hidden = transport.value !== "http";
    };
    transport.addEventListener("change", syncTransport);
    syncTransport();

    const grid = el("div", "form-grid");
    grid.append(field("Nome", name), field("Id (não muda depois)", id), field("Tipo", transport));
    const save = el("button", "btn-primary", mcp ? "Salvar" : "Criar MCP");
    save.type = "submit";
    actions.append(save, button("", "Cancelar", () => this.close()));
    if (mcp) {
      actions.append(
        deleteButton(() =>
          submitting(form, error, async () => {
            await this.api.deleteMcp(mcp.id);
            this.close();
          }),
        ),
      );
    }
    form.append(grid, stdioFields, httpFields, enabledLabel);
    if (mcp) form.append(note("Excluir o MCP tira ele também dos agentes que o usam."));
    form.append(error, actions);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const isStdio = transport.value === "stdio";
      const secrets = secretPayload(isStdio ? env.values() : headers.values());
      if (typeof secrets === "string") {
        error.textContent = secrets;
        return;
      }
      if (!mcp && !isSlug(id.value)) {
        error.textContent = "Id inválido: use letras minúsculas, números, _ e -, até 32 caracteres.";
        return;
      }
      const data = {
        name: name.value.trim(),
        transport: transport.value as "stdio" | "http",
        command: isStdio ? command.value.trim() : "",
        args: isStdio ? parseArgs(args.value) : [],
        url: isStdio ? "" : url.value.trim(),
        env: isStdio ? secrets : {},
        headers: isStdio ? {} : secrets,
        enabled: enabled.checked,
      };
      void submitting(form, error, async () => {
        if (mcp) await this.api.updateMcp(mcp.id, data);
        else await this.api.createMcp({ ...data, id: id.value });
        this.close();
      });
    });

    this.editor.replaceChildren(form);
    this.listView.hidden = true;
    this.editor.hidden = false;
    name.focus();
  }
}

// ----------------------------------------------------------------- agentes

class AgentsPane {
  readonly el = el("section", "cfg-pane");
  private readonly list = el("ul", "rows cfg-rows");
  private readonly listView = el("div");
  private readonly editor = el("div");
  private editing = false;
  private config: PublicConfig | null = null;
  private state: OfficeState | null = null;
  private shownVersion = -1;

  constructor(private readonly api: ConfigApi) {
    const head = el("div", "cfg-head");
    head.append(el("h3", "cfg-title", "Agentes"), button("btn-primary", "Novo agente", () => this.open(null)));
    this.listView.append(
      head,
      note("O time do escritório vem desta lista. Agente ativo entra na sala; desativado ou excluído sai."),
      this.list,
      note(NOT_WIRED),
    );
    this.editor.hidden = true;
    this.el.append(this.listView, this.editor);
  }

  update(config: PublicConfig, version: number, state: OfficeState | null): void {
    this.config = config;
    this.state = state;
    if (this.editing || version === this.shownVersion) return;
    this.shownVersion = version;
    this.renderList();
  }

  private renderList(): void {
    const config = this.config!;
    if (config.agents.length === 0) {
      this.list.replaceChildren(el("li", "empty", "Nenhum agente. O escritório fica vazio."));
      return;
    }

    this.list.replaceChildren(
      ...config.agents.map((agent) => {
        const row = el("li", `row ${agent.enabled ? "status-in_progress" : ""}`);
        const main = button("row-main", "", () => this.open(agent));
        const dot = el("span", "agent-dot");
        const seq = this.state?.agents[agent.id]?.seq;
        dot.style.background = seq === undefined ? "var(--muted)" : shirtColor(seq);
        main.append(dot, el("span", "row-title", agent.name), el("span", "muted", agent.role));
        const tags = el("span", "row-tags");
        if (agent.tool) {
          const ready = toolReady(agent.tool, config.credentials);
          tags.append(
            el(
              "span",
              ready ? "tag" : "tag tag-criteria",
              `${TOOLS[agent.tool]}${agent.model ? ` · ${agent.model}` : ""}${ready ? "" : " · sem credencial"}`,
            ),
          );
        }
        if (agent.mcps.length) {
          tags.append(el("span", "tag tag-tasks", `${agent.mcps.length} ${agent.mcps.length === 1 ? "MCP" : "MCPs"}`));
        }
        tags.append(el("span", `tag tag-status ${agent.enabled ? "task-done" : ""}`, agent.enabled ? "ativo" : "inativo"));
        row.append(main, tags);
        return row;
      }),
    );
  }

  private close(): void {
    this.editing = false;
    this.editor.hidden = true;
    this.editor.replaceChildren();
    this.listView.hidden = false;
    this.shownVersion = -1;
    if (this.config) this.update(this.config, -2, this.state);
  }

  private open(agent: AgentConfig | null): void {
    const config = this.config!;
    this.editing = true;
    const { form, error, actions } = formShell(agent ? `Agente ${agent.name}` : "Novo agente", () =>
      this.close(),
    );
    const name = textInput(agent?.name ?? "", 80, "Especialista de Dados");
    name.required = true;
    const id = textInput(agent?.id ?? "", 32, "dados");
    id.disabled = agent !== null;
    let idTouched = agent !== null;
    id.addEventListener("input", () => (idTouched = true));
    name.addEventListener("input", () => {
      if (!idTouched) id.value = slugify(name.value);
    });
    const role = textInput(agent?.role ?? "", 120, "Modelagem e consultas");
    const tool = select(
      [
        { value: "", label: "Não definida" },
        ...(Object.keys(TOOLS) as ToolId[]).map((id) => ({
          value: id,
          label: toolReady(id, config.credentials) ? TOOLS[id] : `${TOOLS[id]} (sem credencial)`,
        })),
      ],
      agent?.tool ?? "",
    );
    const model = textInput(agent?.model ?? "", 120, "padrão da ferramenta");
    const prompt = textArea(agent?.prompt ?? "", 10, "Você é responsável por…");
    const [enabledLabel, enabled] = checkbox("Ativo (aparece no escritório)", agent?.enabled ?? true);

    const mcpBox = el("div", "checks");
    const mcpInputs = config.mcps.map((mcp) => {
      const [label, input] = checkbox(
        mcp.enabled ? mcp.name : `${mcp.name} (inativo)`,
        agent?.mcps.includes(mcp.id) ?? false,
      );
      mcpBox.append(label);
      return [mcp.id, input] as const;
    });
    if (!config.mcps.length) mcpBox.append(el("span", "muted", "Nenhum MCP configurado. Cadastre na seção MCPs."));

    const grid = el("div", "form-grid");
    grid.append(
      field("Nome", name),
      field("Id (não muda depois)", id),
      field("Papel", role),
      field("Ferramenta", tool),
      field("Modelo", model),
    );
    const save = el("button", "btn-primary", agent ? "Salvar" : "Criar agente");
    save.type = "submit";
    actions.append(save, button("", "Cancelar", () => this.close()));
    if (agent) {
      actions.append(
        deleteButton(() =>
          submitting(form, error, async () => {
            await this.api.deleteAgent(agent.id);
            this.close();
          }),
        ),
      );
    }
    form.append(
      grid,
      field("Prompt do agente", prompt),
      el("span", "field-label", "MCPs que este agente pode usar"),
      mcpBox,
      enabledLabel,
      error,
      actions,
    );

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!agent && !isSlug(id.value)) {
        error.textContent = "Id inválido: use letras minúsculas, números, _ e -, até 32 caracteres.";
        return;
      }
      const data = {
        name: name.value.trim(),
        role: role.value.trim(),
        prompt: prompt.value,
        tool: (tool.value || null) as ToolId | null,
        model: model.value.trim(),
        mcps: mcpInputs.filter(([, input]) => input.checked).map(([mcpId]) => mcpId),
        enabled: enabled.checked,
      };
      void submitting(form, error, async () => {
        if (agent) await this.api.updateAgent(agent.id, data);
        else await this.api.createAgent({ ...data, id: id.value });
        this.close();
      });
    });

    this.editor.replaceChildren(form);
    this.listView.hidden = true;
    this.editor.hidden = false;
    name.focus();
  }
}
