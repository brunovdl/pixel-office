import { Panel } from "./panel";
import { OfficeScene } from "./scene";
import { Simulator } from "./simulator";
import { initialState, reduce } from "./state";

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Elemento #${id} não encontrado`);
  return node as T;
}

const params = new URLSearchParams(location.search);
const seed = Number(params.get("seed") ?? "") || Math.floor(Math.random() * 1e9);

const simulator = new Simulator({ seed });
const scene = new OfficeScene(byId<HTMLCanvasElement>("office"));
const panel = new Panel(byId("agents"), byId("log"), (agentId) =>
  simulator.answerDecision(agentId),
);

let state = initialState;
simulator.subscribe((event) => {
  state = reduce(state, event);
  scene.sync(state);
  panel.renderAgents(state);
  panel.addEvent(event, state);
});

const stage = byId("stage");
const fit = () => scene.resize(stage.clientWidth, stage.clientHeight);
new ResizeObserver(fit).observe(stage);
fit();

let paused = false;
let speed = 1;

const pauseButton = byId<HTMLButtonElement>("btn-pause");
pauseButton.addEventListener("click", () => {
  paused = !paused;
  pauseButton.textContent = paused ? "Retomar" : "Pausar";
});
byId<HTMLSelectElement>("sel-speed").addEventListener("change", (event) => {
  speed = Number((event.target as HTMLSelectElement).value);
});

let last = performance.now();
function frame(now: number): void {
  // Limita o salto quando a aba volta do segundo plano.
  const dt = Math.min(now - last, 100) * speed;
  last = now;
  if (!paused) {
    simulator.tick(dt);
    scene.update(dt / 1000);
  }
  scene.draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
