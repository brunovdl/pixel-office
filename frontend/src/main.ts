import { BoardApi, type BoardData } from "./board";
import { SpecsView, TasksView } from "./boardviews";
import { ConfigApi, EMPTY_CONFIG, type PublicConfig } from "./config";
import { ConfigView } from "./configview";
import type { AgentEvent } from "./events";
import { EventHistory } from "./history";
import { OfficeScene } from "./scene";
import { Simulator } from "./simulator";
import { initialState, pendingDecisions, reduce, type OfficeState } from "./state";
import { AnswerForms, el } from "./ui";
import {
  AgentsView,
  ConversationsView,
  DecisionsView,
  renderAgentBar,
  renderLog,
  renderTeam,
} from "./views";
import { WindowManager } from "./windows";
import { WebSocketFeed, type ConnectionStatus } from "./wsfeed";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado`);
  return node as T;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sem armazenamento: a preferência só não é lembrada.
  }
}

const params = new URLSearchParams(location.search);
const badge = byId("feed-badge");
const canvas = byId<HTMLCanvasElement>("office");
const scene = new OfficeScene(canvas);
const history = new EventHistory();

let state: OfficeState = initialState;

// ------------------------------------------------------------------ origem

/** `?sim` roda o simulador no navegador, sem backend. */
const simulator = params.has("sim")
  ? new Simulator({ seed: Number(params.get("seed") ?? "") || Math.floor(Math.random() * 1e9) })
  : null;

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "conectando…",
  open: "ao vivo",
  closed: "sem conexão, tentando de novo",
};

function setBadge(text: string, tone: "open" | "closed" | null): void {
  badge.textContent = text;
  badge.title = text;
  badge.classList.toggle("is-open", tone === "open");
  badge.classList.toggle("is-closed", tone === "closed");
}

function backendUrl(): string {
  const url = new URL(params.get("ws") ?? "/ws", location.href);
  url.protocol = url.protocol.replace("http", "ws");
  const token = params.get("token");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

let board: BoardData = { tasks: [], specs: [] };
let boardVersion = 0;

let config: PublicConfig = EMPTY_CONFIG;
let configVersion = 0;
const configApi = simulator
  ? null
  : new ConfigApi(backendUrl().replace(/^ws/, "http"), params.get("token"));

const api = simulator
  ? null
  : new BoardApi(backendUrl().replace(/^ws/, "http"), params.get("token"));

const backend = simulator
  ? null
  : new WebSocketFeed({
      url: backendUrl(),
      onConfig: (next) => {
        config = next;
        configVersion++;
        applyBranding();
        scheduleRender();
      },
      onBoard: (next) => {
        board = next;
        boardVersion++;
        scheduleRender();
      },
      onSnapshot: (snapshot, recent) => {
        history.replace(recent);
        state = snapshot;
        scene.sync(state, true);
        scheduleRender();
      },
      onStatus: (status) =>
        setBadge(STATUS_TEXT[status], status === "connecting" ? null : status),
      onServerError: (message) => console.warn(`Backend recusou: ${message}`),
    });

const feed = simulator ?? backend!;
feed.subscribe((event: AgentEvent) => {
  state = reduce(state, event);
  history.add(event);
  scene.sync(state);
  scheduleRender();
});

// ----------------------------------------------------------------- janelas

const wm = new WindowManager(byId("win-layer"), "pixel-office:windows:v1");
const forms = new AnswerForms((agentId, answer) => feed.answerDecision(agentId, answer));

interface DockItem {
  id: string;
  label: string;
  icon: string;
  badge?: () => number;
  /** Contagem que pede atenção (amarela) em vez de informativa. */
  alert?: boolean;
}

const conversations = new ConversationsView(
  wm.register({
    id: "conversas",
    title: "Conversas",
    size: { w: 900, h: 580 },
    min: { w: 440, h: 280 },
    bodyClass: "conv",
  }),
  forms,
  () => scheduleRender(),
);
const decisions = new DecisionsView(
  wm.register({
    id: "decisoes",
    title: "Decisões pendentes",
    tone: "alert",
    size: { w: 580, h: 480 },
    min: { w: 320, h: 200 },
    bodyClass: "pad",
  }),
  forms,
  openConversation,
);
const tasksView = new TasksView(
  wm.register({
    id: "tarefas",
    title: "Quadro de tarefas",
    size: { w: 860, h: 560 },
    min: { w: 380, h: 260 },
    bodyClass: "board",
  }),
  api,
  (specId) => {
    specsView.update(board, boardVersion, state);
    specsView.openSpec(specId);
    wm.open("specs");
  },
);
const specsView: SpecsView = new SpecsView(
  wm.register({
    id: "specs",
    title: "Quadro de specs",
    size: { w: 900, h: 600 },
    min: { w: 400, h: 260 },
    bodyClass: "board",
  }),
  api,
  (taskId) => {
    tasksView.update(board, boardVersion, state);
    tasksView.openTask(taskId);
    wm.open("tarefas");
  },
);
const configView = new ConfigView(
  wm.register({
    id: "config",
    title: "Configurações",
    size: { w: 980, h: 660 },
    min: { w: 480, h: 320 },
    bodyClass: "cfg",
  }),
  configApi,
);
const agents = new AgentsView(
  wm.register({
    id: "agentes",
    title: "Agentes",
    size: { w: 760, h: 520 },
    min: { w: 320, h: 220 },
    bodyClass: "pad",
  }),
  openConversation,
);

const DOCK: DockItem[] = [
  { id: "conversas", label: "Conversas", icon: "✉" },
  {
    id: "tarefas",
    label: "Tarefas",
    icon: "≡",
    badge: () => board.tasks.filter((task) => task.status === "blocked").length,
    alert: true,
  },
  {
    id: "specs",
    label: "Specs",
    icon: "≡",
    badge: () => board.specs.filter((spec) => spec.status === "draft").length,
  },
  {
    id: "decisoes",
    label: "Decisões",
    icon: "?",
    badge: () => pendingDecisions(state),
    alert: true,
  },
  { id: "agentes", label: "Agentes", icon: "☺" },
  { id: "config", label: "Config", icon: "⚙" },
];

const dock = byId("dock");
const dockButtons = DOCK.map((item) => {
  const node = el("button", "dock-btn");
  node.type = "button";
  node.dataset.win = item.id;
  const count = el("span", "dock-badge");
  count.hidden = true;
  node.append(el("span", "dock-icon", item.icon), el("span", "dock-label", item.label), count);
  node.addEventListener("click", () => wm.toggle(item.id));
  dock.append(node);
  return { item, node, count };
});

function updateDock(): void {
  for (const { item, node, count } of dockButtons) {
    const status = wm.status(item.id);
    node.classList.toggle("is-open", status.visibility === "open");
    node.classList.toggle("is-min", status.visibility === "minimized");
    node.classList.toggle("is-active", status.focused);
    node.setAttribute("aria-pressed", String(status.visibility === "open"));
    node.title =
      status.visibility === "minimized" ? `${item.label} (minimizada)` : item.label;
    const value = item.badge?.() ?? 0;
    count.hidden = value === 0;
    count.textContent = String(value);
    node.classList.toggle("has-alert", value > 0 && item.alert === true);
  }
}

function openConversation(agentId: string): void {
  conversations.select(agentId);
  wm.open("conversas");
  scheduleRender();
}

wm.onChange(() => {
  updateDock();
  scheduleRender();
});

// ------------------------------------------------------------------ telas

const team = byId("team");
const log = byId("log");
const agentbar = byId("agentbar");
let renderQueued = false;
let logVersion = -1;

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  forms.prune(state);
  renderTeam(team, state, openConversation);
  renderAgentBar(agentbar, state, openConversation);
  if (history.version !== logVersion) {
    renderLog(log, state, history);
    logVersion = history.version;
  }
  if (wm.isOpen("conversas")) conversations.render(state, history);
  if (wm.isOpen("decisoes")) decisions.render(state, history);
  if (wm.isOpen("agentes")) agents.render(state);
  if (wm.isOpen("tarefas")) tasksView.update(board, boardVersion, state);
  if (wm.isOpen("specs")) specsView.update(board, boardVersion, state);
  if (wm.isOpen("config")) configView.update(config, configVersion, state);
  updateDock();
}

// ------------------------------------------------------------------ marca

const brandLogo = byId<HTMLImageElement>("brand-logo");
const brandName = byId("brand-name");
let shownLogo: number | null = null;

function applyBranding(): void {
  const { name, logo } = config.office;
  brandName.textContent = name;
  document.title = name;
  const version = logo?.updatedAt ?? null;
  if (version === shownLogo) return;
  shownLogo = version;
  if (!logo || !configApi) {
    brandLogo.hidden = true;
    brandLogo.removeAttribute("src");
    scene.setLogo(null);
    return;
  }
  const url = configApi.logoUrl(logo.updatedAt);
  brandLogo.src = url;
  brandLogo.alt = `Logo de ${name}`;
  brandLogo.hidden = false;
  const image = new Image();
  image.onload = () => {
    if (shownLogo === version) scene.setLogo(image);
  };
  image.src = url;
}

// --------------------------------------------------------- painel lateral

const side = byId("side");
const sideButton = byId<HTMLButtonElement>("btn-side");
function setSide(open: boolean): void {
  side.hidden = !open;
  sideButton.textContent = open ? "◀" : "▶";
  sideButton.setAttribute("aria-expanded", String(open));
  sideButton.title = open ? "Recolher painel" : "Mostrar painel";
  sideButton.setAttribute("aria-label", sideButton.title);
  writeStorage("pixel-office:side", open ? "open" : "closed");
}
sideButton.addEventListener("click", () => setSide(side.hidden));
setSide(readStorage("pixel-office:side") !== "closed");

// ---------------------------------------------------------------- cena

canvas.addEventListener("click", (event) => {
  const id = scene.actorAt(event.clientX, event.clientY);
  if (id) openConversation(id);
});
canvas.addEventListener("pointermove", (event) => {
  canvas.style.cursor = scene.actorAt(event.clientX, event.clientY) ? "pointer" : "";
});

const stage = byId("stage");
const fit = () => scene.resize(stage.clientWidth, stage.clientHeight);
new ResizeObserver(fit).observe(stage);
fit();

let paused = false;
let speed = 1;

if (simulator) {
  setBadge("simulação", "open");
  byId("sim-controls").hidden = false;
  const pauseButton = byId<HTMLButtonElement>("btn-pause");
  pauseButton.addEventListener("click", () => {
    paused = !paused;
    pauseButton.textContent = paused ? "Retomar" : "Pausar";
  });
  byId<HTMLSelectElement>("sel-speed").addEventListener("change", (event) => {
    speed = Number((event.target as HTMLSelectElement).value);
  });
}

backend?.start();
render();

let last = performance.now();
function frame(now: number): void {
  // Limita o salto quando a aba volta do segundo plano.
  const dt = Math.min(now - last, 100) * speed;
  last = now;
  if (!paused) {
    simulator?.tick(dt);
    scene.update(dt / 1000);
  }
  scene.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
