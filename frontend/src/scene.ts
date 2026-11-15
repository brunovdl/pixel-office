/** Desenha o escritório e move os agentes conforme o estado. */

import {
  DESKS,
  ENTRANCE,
  FURNITURE,
  HEIGHT,
  IDLE_SPOTS,
  TILE,
  WALL_ROWS,
  WIDTH,
  findPath,
  isWalkable,
  seatPoint,
  seatTile,
  standPoint,
  tileOf,
  type Point,
  type Tile,
} from "./grid";
import { lookFor } from "./look";
import {
  SPRITE_H,
  SPRITE_W,
  buildCharacter,
  drawGlyph,
  type CharacterSprites,
  type GlyphName,
} from "./sprites";
import { pendingDecisions, type AgentStatus, type OfficeState } from "./state";

const WALK_SPEED = 38; // pixels lógicos por segundo
const DONE_AT_DESK_S = 2.5;
const AT_DESK = new Set<AgentStatus>([
  "thinking",
  "reading",
  "writing",
  "running",
  "waiting",
  "error",
]);

interface Actor {
  id: string;
  name: string;
  status: AgentStatus;
  sprites: CharacterSprites;
  skin: string;
  pos: Point;
  path: Point[];
  desk: number | null;
  spot: number | null;
  /** Para onde o caminho atual leva; evita recalcular a rota todo quadro. */
  goal: string;
  seated: boolean;
  /** Segundos no status atual. */
  statusTime: number;
  /** Segundos até trocar de lugar quando está livre. */
  wander: number;
  walkTime: number;
}

interface Drawable {
  sortY: number;
  draw: () => void;
}

export class OfficeScene {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly background: HTMLCanvasElement;
  private readonly actors = new Map<string, Actor>();
  private scale = 1;
  private time = 0;
  private pending = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.background = this.paintBackground();
    this.resize(WIDTH, HEIGHT);
  }

  /** Ajusta o canvas ao espaço disponível, sempre em escala inteira. */
  resize(availableWidth: number, availableHeight: number): void {
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min((availableWidth * dpr) / WIDTH, (availableHeight * dpr) / HEIGHT);
    this.scale = Math.max(1, Math.floor(fit));
    this.canvas.width = WIDTH * this.scale;
    this.canvas.height = HEIGHT * this.scale;
    this.canvas.style.width = `${(WIDTH * this.scale) / dpr}px`;
    this.canvas.style.height = `${(HEIGHT * this.scale) / dpr}px`;
  }

  /** Alinha os atores com o estado: cria, remove e atualiza status. */
  sync(state: OfficeState): void {
    this.pending = pendingDecisions(state);

    for (const id of this.actors.keys()) {
      if (!state.agents[id]) this.actors.delete(id);
    }
    for (const id of state.order) {
      const agent = state.agents[id]!;
      let actor = this.actors.get(id);
      if (!actor) {
        const look = lookFor(id, agent.seq);
        actor = {
          id,
          name: agent.name,
          status: agent.status,
          sprites: buildCharacter(look),
          skin: look.skin,
          pos: standPoint(ENTRANCE),
          path: [],
          desk: this.freeDesk(),
          spot: null,
          goal: "",
          seated: false,
          statusTime: 0,
          wander: 0,
          walkTime: 0,
        };
        this.actors.set(id, actor);
      }
      actor.name = agent.name;
      if (actor.status !== agent.status) {
        actor.status = agent.status;
        actor.statusTime = 0;
      }
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const actor of this.actors.values()) this.updateActor(actor, dt);
  }

  draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.background, 0, 0);
    this.drawDecisionNotes();

    const items: Drawable[] = [
      { sortY: 48, draw: () => this.drawBookshelf() },
      { sortY: 48, draw: () => this.drawCoffee() },
      ...FURNITURE.plants.map((t) => ({
        sortY: (t.row + 1) * TILE,
        draw: () => this.drawPlant(t),
      })),
      { sortY: 8 * TILE, draw: () => this.drawCooler() },
    ];
    DESKS.forEach((desk, index) => {
      const owner = this.deskOwner(index);
      items.push({ sortY: desk.row * TILE - 1, draw: () => this.drawChair(desk) });
      items.push({ sortY: (desk.row + 1) * TILE, draw: () => this.drawDesk(desk, index, owner) });
    });
    for (const actor of this.actors.values()) {
      items.push({ sortY: actor.pos.y, draw: () => this.drawActor(actor) });
    }
    items.sort((a, b) => a.sortY - b.sortY);
    for (const item of items) item.draw();

    for (const actor of this.actors.values()) this.drawBubble(actor);
    for (const actor of this.actors.values()) this.drawLabel(actor);
  }

  // ---------------------------------------------------------------- movimento

  private freeDesk(): number | null {
    const taken = new Set([...this.actors.values()].map((a) => a.desk));
    const index = DESKS.findIndex((_, i) => !taken.has(i));
    return index === -1 ? null : index;
  }

  private freeSpot(current: number | null): number {
    const taken = new Set([...this.actors.values()].map((a) => a.spot));
    const free = IDLE_SPOTS.map((_, i) => i).filter((i) => !taken.has(i));
    if (free.length === 0) return current ?? 0;
    return free[Math.floor(Math.random() * free.length)]!;
  }

  private deskOwner(index: number): Actor | undefined {
    for (const actor of this.actors.values()) {
      if (actor.desk === index) return actor;
    }
    return undefined;
  }

  private worksAtDesk(actor: Actor): boolean {
    if (actor.desk === null) return false;
    if (AT_DESK.has(actor.status)) return true;
    return actor.status === "done" && actor.statusTime < DONE_AT_DESK_S;
  }

  private updateActor(actor: Actor, dt: number): void {
    actor.statusTime += dt;

    let goal: string;
    let goalTile: Tile;
    let goalPoint: Point;
    if (this.worksAtDesk(actor)) {
      const desk = DESKS[actor.desk!]!;
      actor.spot = null;
      goal = "desk";
      goalTile = seatTile(desk);
      goalPoint = seatPoint(desk);
    } else {
      const arrived = actor.path.length === 0 && actor.goal.startsWith("spot");
      if (arrived) actor.wander -= dt;
      if (actor.spot === null || (arrived && actor.wander <= 0)) {
        actor.spot = this.freeSpot(actor.spot);
        actor.wander = 6 + Math.random() * 10;
      }
      goal = `spot${actor.spot}`;
      goalTile = IDLE_SPOTS[actor.spot]!;
      goalPoint = standPoint(goalTile);
    }

    if (goal !== actor.goal) {
      actor.goal = goal;
      actor.seated = false;
      actor.path = this.route(actor.pos, goalTile, goalPoint);
    }

    let budget = WALK_SPEED * dt;
    while (budget > 0 && actor.path.length > 0) {
      const target = actor.path[0]!;
      const dx = target.x - actor.pos.x;
      const dy = target.y - actor.pos.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= budget) {
        actor.pos = { ...target };
        actor.path.shift();
        budget -= distance;
      } else {
        actor.pos.x += (dx / distance) * budget;
        actor.pos.y += (dy / distance) * budget;
        budget = 0;
      }
    }

    const moving = actor.path.length > 0;
    actor.walkTime = moving ? actor.walkTime + dt : 0;
    actor.seated = goal === "desk" && !moving;
  }

  private route(from: Point, toTile: Tile, toPoint: Point): Point[] {
    // Quem está sentado tem os pés dentro do tile da mesa; sai pela cadeira.
    let start = tileOf(from);
    while (!isWalkable(start) && start.row > WALL_ROWS) {
      start = { col: start.col, row: start.row - 1 };
    }
    const tiles = findPath(start, toTile) ?? [];
    return [standPoint(start), ...tiles.map(standPoint), toPoint];
  }

  // ------------------------------------------------------------------ desenho

  private rect(color: string, x: number, y: number, w: number, h: number): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  private paintBackground(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d")!;
    const rect = (color: string, x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };

    // Piso em carpete xadrez.
    for (let row = WALL_ROWS; row < HEIGHT / TILE; row++) {
      for (let col = 0; col < WIDTH / TILE; col++) {
        rect((row + col) % 2 === 0 ? "#6f7e96" : "#69788f", col * TILE, row * TILE, TILE, TILE);
      }
    }

    // Parede do fundo.
    const wallH = WALL_ROWS * TILE;
    rect("#e9dfc8", 0, 0, WIDTH, wallH);
    rect("#d6cab0", 0, 0, WIDTH, 3);
    rect("#8a6f52", 0, wallH - 3, WIDTH, 3);
    rect("rgba(0,0,0,0.18)", 0, wallH, WIDTH, 2);

    // Janelas.
    for (const x of [50, 194]) {
      rect("#f7f2e4", x, 5, 46, 19);
      rect("#9fd3f0", x + 2, 7, 42, 15);
      rect("#c4e6f8", x + 5, 9, 9, 3);
      rect("#c4e6f8", x + 28, 14, 11, 3);
      rect("#f7f2e4", x + 22, 7, 2, 15);
    }

    // Quadro de decisões.
    rect("#8d8d94", 112, 4, 66, 21);
    rect("#fbfbf5", 114, 6, 62, 17);

    // Tapete da área de descanso.
    rect("#c9777a", 96, 172, 96, 34);
    rect("#a8555a", 98, 174, 92, 30);
    rect("#b9666a", 104, 180, 80, 18);

    // Capacho da entrada.
    rect("#4d5566", ENTRANCE.col * TILE + 2, ENTRANCE.row * TILE + 4, 12, 9);

    return canvas;
  }

  private drawDecisionNotes(): void {
    // O texto é desenhado a cada quadro para sair nítido na escala final.
    this.ctx.fillStyle = "#5b6070";
    this.ctx.font = "bold 5px monospace";
    this.ctx.textBaseline = "top";
    this.ctx.fillText("DECISÕES", 116, 7);
    for (let i = 0; i < Math.min(this.pending, 8); i++) {
      const x = 117 + (i % 8) * 7;
      this.rect("#c9a227", x, 15, 6, 6);
      this.rect("#ffd84d", x, 14, 6, 6);
    }
  }

  private drawBookshelf(): void {
    this.rect("#6b4627", 1, 10, 30, 37);
    this.rect("#8a5c34", 3, 12, 26, 33);
    const books = ["#e5484d", "#3e9bff", "#f5a524", "#46c36f", "#a26bf5", "#e8e3d3"];
    for (let shelf = 0; shelf < 3; shelf++) {
      const y = 13 + shelf * 11;
      for (let i = 0; i < 8; i++) {
        const tall = 6 + ((i * 7 + shelf * 3) % 3);
        this.rect(books[(i + shelf * 2) % books.length]!, 4 + i * 3, y + 9 - tall, 2, tall);
      }
      this.rect("#6b4627", 3, y + 9, 26, 2);
    }
  }

  private drawCoffee(): void {
    const x = 17 * TILE;
    this.rect("#8f8779", x, 36, 32, 11);
    this.rect("#dcd5c8", x, 31, 32, 6);
    this.rect("#2b2f38", x + 4, 17, 11, 15);
    this.rect("#444a57", x + 5, 18, 9, 5);
    this.rect("#e5484d", x + 12, 25, 2, 2);
    this.rect("#15171c", x + 7, 26, 4, 5);
    this.rect("#f4f4f0", x + 20, 27, 4, 4);
    this.rect("#f4f4f0", x + 26, 27, 4, 4);
  }

  private drawPlant(tile: Tile): void {
    const x = tile.col * TILE;
    const y = tile.row * TILE;
    this.rect("#2f8f4e", x + 5, y - 6, 6, 10);
    this.rect("#3fae62", x + 2, y - 2, 5, 7);
    this.rect("#3fae62", x + 9, y - 3, 5, 8);
    this.rect("#57c47a", x + 6, y - 9, 3, 6);
    this.rect("#b0613a", x + 4, y + 5, 8, 8);
    this.rect("#c9774b", x + 3, y + 4, 10, 3);
  }

  private drawCooler(): void {
    const x = FURNITURE.cooler[0].col * TILE;
    const y = FURNITURE.cooler[0].row * TILE;
    this.rect("#8fd0ef", x + 4, y - 8, 8, 9);
    this.rect("#b9e4f7", x + 5, y - 7, 2, 6);
    this.rect("#e8e8ea", x + 3, y + 1, 10, 13);
    this.rect("#c5c5cb", x + 3, y + 11, 10, 3);
    this.rect("#3e9bff", x + 5, y + 4, 2, 2);
    this.rect("#e5484d", x + 9, y + 4, 2, 2);
  }

  private drawChair(desk: Tile): void {
    const x = desk.col * TILE + 10;
    const y = desk.row * TILE - 13;
    this.rect("#343c4d", x, y, 12, 13);
    this.rect("#465066", x + 1, y + 1, 10, 3);
  }

  private drawDesk(desk: Tile, index: number, owner: Actor | undefined): void {
    const x = desk.col * TILE;
    const y = desk.row * TILE;
    const seated = owner?.seated ?? false;

    // Tampo, frente e pés.
    this.rect("#cf9a61", x, y - 2, 32, 1);
    this.rect("#b9834c", x, y - 1, 32, 8);
    this.rect("#8f5f33", x, y + 7, 32, 7);
    this.rect("#7a4f29", x + 2, y + 9, 28, 1);
    this.rect("#5f3e20", x + 1, y + 14, 2, 2);
    this.rect("#5f3e20", x + 29, y + 14, 2, 2);

    // Teclado e mãos.
    this.rect("#dadbe0", x + 11, y + 1, 10, 3);
    this.rect("#b9bbc4", x + 12, y + 2, 8, 1);
    if (owner && seated) {
      const typing = owner.status === "writing" || owner.status === "running";
      const beat = typing && Math.floor(this.time * 8) % 2 === 0;
      this.rect(owner.skin, x + 12, y - 1 + (beat ? 1 : 0), 2, 2);
      this.rect(owner.skin, x + 18, y - 1 + (beat ? 0 : 1), 2, 2);
    }

    // Objeto pessoal no canto esquerdo.
    if (index % 3 === 0) {
      this.rect("#f4f4f0", x + 3, y - 1, 4, 4);
      this.rect("#6b4627", x + 4, y, 2, 1);
    } else if (index % 3 === 1) {
      this.rect("#f4f4f0", x + 2, y, 6, 5);
      this.rect("#c5c5cb", x + 3, y + 1, 4, 1);
      this.rect("#c5c5cb", x + 3, y + 3, 3, 1);
    } else {
      this.rect("#3fae62", x + 3, y - 4, 4, 4);
      this.rect("#b0613a", x + 3, y, 4, 3);
    }

    // Monitor.
    this.rect("#2b2f38", x + 22, y - 11, 9, 8);
    this.rect("#2b2f38", x + 25, y - 3, 3, 2);
    this.rect("#1d2027", x + 24, y - 1, 5, 1);
    this.drawScreen(x + 23, y - 10, seated ? owner!.status : "idle", index);
  }

  /** Tela de 7x6 que mostra o que o dono da mesa está fazendo. */
  private drawScreen(x: number, y: number, status: AgentStatus, index: number): void {
    const t = this.time + index * 0.37;
    const lines = (color: string, speed: number) => {
      const offset = Math.floor(t * speed);
      for (let row = 0; row < 3; row++) {
        const width = 2 + ((offset + row * 3 + index) % 4);
        this.rect(color, x + 1, y + 1 + row * 2, width, 1);
      }
    };
    switch (status) {
      case "thinking": {
        this.rect("#24304a", x, y, 7, 6);
        const lit = Math.floor(t * 3) % 3;
        for (let i = 0; i < 3; i++) {
          this.rect(i === lit ? "#ffffff" : "#5d6c8f", x + 1 + i * 2, y + 3, 1, 1);
        }
        break;
      }
      case "reading":
        this.rect("#eef1f5", x, y, 7, 6);
        lines("#7b8494", 1);
        break;
      case "writing":
        this.rect("#1e2233", x, y, 7, 6);
        lines("#7cc4ff", 4);
        break;
      case "running":
        this.rect("#0c100c", x, y, 7, 6);
        lines("#4ade80", 3);
        if (Math.floor(t * 2) % 2 === 0) this.rect("#4ade80", x + 5, y + 5, 1, 1);
        break;
      case "waiting":
        this.rect(Math.floor(t * 2) % 2 === 0 ? "#ffd84d" : "#c9a227", x, y, 7, 6);
        break;
      case "error":
        this.rect("#d64545", x, y, 7, 6);
        break;
      case "done":
        this.rect("#2f9e5b", x, y, 7, 6);
        break;
      default:
        this.rect("#171a20", x, y, 7, 6);
    }
  }

  private drawActor(actor: Actor): void {
    const moving = actor.path.length > 0;
    let frame: keyof CharacterSprites = "stand";
    if (moving) frame = Math.floor(actor.walkTime / 0.15) % 2 === 0 ? "walkA" : "walkB";
    const x = Math.round(actor.pos.x - SPRITE_W / 2);
    const y = Math.round(actor.pos.y - SPRITE_H);
    if (!actor.seated) this.rect("rgba(0,0,0,0.22)", x + 1, y + SPRITE_H - 1, 8, 2);
    this.ctx.drawImage(actor.sprites[frame], x, y);
  }

  private drawBubble(actor: Actor): void {
    let fill: string;
    let glyph: GlyphName | "dots";
    let ink = "#1d1d24";
    switch (actor.status) {
      case "thinking":
        if (!actor.seated) return;
        fill = "#ffffff";
        glyph = "dots";
        break;
      case "waiting":
        fill = "#ffd84d";
        glyph = "question";
        break;
      case "error":
        fill = "#e5484d";
        glyph = "exclamation";
        ink = "#ffffff";
        break;
      case "done":
        if (actor.statusTime > DONE_AT_DESK_S) return;
        fill = "#46c36f";
        glyph = "check";
        ink = "#ffffff";
        break;
      default:
        return;
    }

    const bob = actor.status === "waiting" && Math.floor(this.time * 2) % 2 === 0 ? 1 : 0;
    const x = Math.round(actor.pos.x) - 5;
    const y = Math.round(actor.pos.y) - SPRITE_H - 12 - bob;
    this.rect("#1d1d24", x, y, 11, 9);
    this.rect(fill, x + 1, y + 1, 9, 7);
    this.rect("#1d1d24", x + 4, y + 9, 3, 1);
    this.rect("#1d1d24", x + 5, y + 10, 1, 1);

    if (glyph === "dots") {
      const lit = Math.floor(this.time * 3) % 3;
      for (let i = 0; i < 3; i++) {
        this.rect(i === lit ? "#1d1d24" : "#b5b8c2", x + 2 + i * 3, y + 4, 1, 1);
      }
    } else {
      const width = glyph === "check" ? 5 : glyph === "question" ? 3 : 1;
      drawGlyph(this.ctx, glyph, x + Math.floor((11 - width) / 2), y + 2, ink);
    }
  }

  private drawLabel(actor: Actor): void {
    const ctx = this.ctx;
    ctx.font = "bold 5px monospace";
    ctx.textBaseline = "top";
    const width = Math.ceil(ctx.measureText(actor.name).width);
    const atDesk = actor.seated && actor.desk !== null;
    const below = atDesk ? (DESKS[actor.desk!]!.row + 1) * TILE + 1 : Math.round(actor.pos.y) + 2;
    const y = Math.min(below, HEIGHT - 7);
    const x = Math.round(
      Math.min(Math.max(actor.pos.x - width / 2, 2), WIDTH - width - 2),
    );
    this.rect("rgba(18,21,28,0.78)", x - 2, y - 1, width + 4, 7);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(actor.name, x, y);
  }
}
