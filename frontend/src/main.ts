import type { AgentEvent } from "./events";
import { Panel } from "./panel";
import { OfficeScene } from "./scene";
import { Simulator } from "./simulator";
import { initialState, reduce, type OfficeState } from "./state";
import { WebSocketFeed, type ConnectionStatus } from "./wsfeed";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado`);
  return node as T;
}

const params = new URLSearchParams(location.search);
const badge = byId("feed-badge");
const scene = new OfficeScene(byId<HTMLCanvasElement>("office"));

let state = initialState;
function show(next: OfficeState, settled = false): void {
  state = next;
  scene.sync(state, settled);
  panel.renderAgents(state);
}
function onEvent(event: AgentEvent): void {
  show(reduce(state, event));
  panel.addEvent(event, state);
}

/** `?sim` roda o simulador no navegador, sem backend. */
const simulator = params.has("sim")
  ? new Simulator({ seed: Number(params.get("seed") ?? "") || Math.floor(Math.random() * 1e9) })
  : null;

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "conectando…",
  open: "conectado ao backend",
  closed: "sem conexão, tentando de novo",
};

function backendUrl(): string {
  const url = new URL(params.get("ws") ?? "/ws", location.href);
  url.protocol = url.protocol.replace("http", "ws");
  const token = params.get("token");
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

const backend = simulator
  ? null
  : new WebSocketFeed({
      url: backendUrl(),
      onSnapshot: (snapshot) => show(snapshot, true),
      onStatus: (status) => {
        badge.textContent = STATUS_TEXT[status];
        badge.classList.toggle("is-open", status === "open");
        badge.classList.toggle("is-closed", status === "closed");
      },
      onServerError: (message) => console.warn(`Backend recusou: ${message}`),
    });

const feed = simulator ?? backend!;
const panel = new Panel(byId("agents"), byId("log"), (agentId, answer) =>
  feed.answerDecision(agentId, answer),
);
feed.subscribe(onEvent);
backend?.start();

const stage = byId("stage");
const fit = () => scene.resize(stage.clientWidth, stage.clientHeight);
new ResizeObserver(fit).observe(stage);
fit();

let paused = false;
let speed = 1;

if (simulator) {
  badge.textContent = "eventos simulados";
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
