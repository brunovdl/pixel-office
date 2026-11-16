/**
 * Janelas flutuantes: arrastar pela barra, redimensionar pelas bordas e cantos,
 * minimizar, maximizar (botão ou duplo clique na barra) e fechar.
 * Posição, tamanho e estado ficam salvos no navegador.
 */

import {
  EDGES,
  cascadeRect,
  fitRect,
  moveRect,
  resizeRect,
  type Edge,
  type Rect,
  type Size,
} from "./geometry";

export type Visibility = "closed" | "open" | "minimized";

export interface WindowSpec {
  id: string;
  title: string;
  /** Barra de título em destaque, como na janela de decisões. */
  tone?: "alert";
  /** Tamanho ao abrir pela primeira vez. */
  size: Size;
  min?: Size;
  /** Classe extra no corpo, para o layout do conteúdo. */
  bodyClass?: string;
}

export interface WindowStatus {
  visibility: Visibility;
  maximized: boolean;
  focused: boolean;
}

interface Saved {
  visibility: Visibility;
  maximized: boolean;
  rect: Rect | null;
}

interface Win {
  spec: WindowSpec;
  index: number;
  el: HTMLElement;
  maxButton: HTMLButtonElement;
  visibility: Visibility;
  maximized: boolean;
  rect: Rect | null;
  z: number;
}

const DEFAULT_MIN: Size = { w: 300, h: 200 };

/** Abaixo desta largura, as janelas sempre ocupam a área inteira. */
export const COMPACT_WIDTH = 720;

const VISIBILITIES = new Set<Visibility>(["closed", "open", "minimized"]);

function button(className: string, text: string, label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return ["x", "y", "w", "h"].every((k) => typeof r[k] === "number" && Number.isFinite(r[k]));
}

export class WindowManager {
  private readonly windows = new Map<string, Win>();
  private readonly listeners = new Set<() => void>();
  private area: Size = { w: 0, h: 0 };
  private zTop = 0;
  private focusedId: string | null = null;

  constructor(
    private readonly layer: HTMLElement,
    private readonly storageKey: string,
  ) {
    new ResizeObserver(() => this.layout()).observe(layer);
    layer.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const id = (event.target as HTMLElement).closest<HTMLElement>(".win")?.dataset.win;
      if (!id) return;
      event.preventDefault();
      this.close(id);
    });
  }

  /** Cria a janela e devolve o elemento onde vai o conteúdo. */
  register(spec: WindowSpec): HTMLElement {
    const saved = this.load()[spec.id];

    const el = document.createElement("section");
    el.className = spec.tone === "alert" ? "win win-alert" : "win";
    el.dataset.win = spec.id;
    el.tabIndex = -1;
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", spec.title);

    const bar = document.createElement("header");
    bar.className = "win-bar";
    bar.title = "Arraste para mover · duplo clique para maximizar";
    const title = document.createElement("span");
    title.className = "win-title";
    title.textContent = spec.title;
    const minimize = button("win-btn", "_", "Minimizar");
    const maximize = button("win-btn", "□", "Maximizar");
    const close = button("win-btn win-close", "✕", "Fechar");
    const actions = document.createElement("div");
    actions.className = "win-actions";
    actions.append(minimize, maximize, close);
    bar.append(title, actions);

    const body = document.createElement("div");
    body.className = spec.bodyClass ? `win-body ${spec.bodyClass}` : "win-body";
    el.append(bar, body);

    const win: Win = {
      spec,
      index: this.windows.size,
      el,
      maxButton: maximize,
      visibility: saved?.visibility ?? "closed",
      maximized: saved?.maximized ?? false,
      rect: saved?.rect ?? null,
      z: 0,
    };

    for (const edge of EDGES) {
      const grip = document.createElement("div");
      grip.className = `win-grip win-grip-${edge}`;
      grip.addEventListener("pointerdown", (event) => this.startDrag(win, event, edge));
      el.append(grip);
    }

    el.addEventListener("pointerdown", () => this.focus(spec.id), { capture: true });
    minimize.addEventListener("click", () => this.minimize(spec.id));
    maximize.addEventListener("click", () => this.toggleMaximize(spec.id));
    close.addEventListener("click", () => this.close(spec.id));
    bar.addEventListener("pointerdown", (event) => this.startDrag(win, event, null));
    bar.addEventListener("dblclick", (event) => {
      if (!(event.target as Element).closest("button")) this.toggleMaximize(spec.id);
    });

    this.windows.set(spec.id, win);
    this.layer.append(el);
    if (win.visibility === "open") {
      this.raise(win);
      this.focusedId = spec.id;
      this.markFocus();
    }
    this.apply(win);
    return body;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(id: string): WindowStatus {
    const win = this.get(id);
    return {
      visibility: win.visibility,
      maximized: win.maximized,
      focused: win.visibility === "open" && this.focusedId === id,
    };
  }

  isOpen(id: string): boolean {
    return this.get(id).visibility === "open";
  }

  open(id: string): void {
    const win = this.get(id);
    win.visibility = "open";
    this.apply(win);
    this.focus(id);
    win.el.focus({ preventScroll: true });
    this.commit();
  }

  close(id: string): void {
    this.hide(id, "closed");
  }

  minimize(id: string): void {
    this.hide(id, "minimized");
  }

  toggleMaximize(id: string): void {
    const win = this.get(id);
    win.maximized = !win.maximized;
    this.apply(win);
    this.commit();
  }

  /** Comportamento do botão no topo: abre, traz para frente ou minimiza. */
  toggle(id: string): void {
    const win = this.get(id);
    if (win.visibility !== "open") this.open(id);
    else if (this.focusedId === id) this.minimize(id);
    else {
      this.focus(id);
      win.el.focus({ preventScroll: true });
    }
  }

  focus(id: string): void {
    const win = this.get(id);
    if (win.visibility !== "open") return;
    if (this.focusedId === id && win.z === this.zTop) return;
    this.raise(win);
    this.focusedId = id;
    this.markFocus();
    this.emit();
  }

  private get compact(): boolean {
    return this.area.w > 0 && this.area.w < COMPACT_WIDTH;
  }

  private get(id: string): Win {
    const win = this.windows.get(id);
    if (!win) throw new Error(`Janela ${id} não registrada`);
    return win;
  }

  private hide(id: string, visibility: Visibility): void {
    const win = this.get(id);
    win.visibility = visibility;
    this.apply(win);
    if (this.focusedId === id) {
      const next = [...this.windows.values()]
        .filter((w) => w.visibility === "open")
        .sort((a, b) => b.z - a.z)[0];
      this.focusedId = next?.spec.id ?? null;
      this.markFocus();
    }
    this.commit();
  }

  private raise(win: Win): void {
    win.z = ++this.zTop;
    win.el.style.zIndex = String(win.z);
  }

  private markFocus(): void {
    for (const win of this.windows.values()) {
      win.el.classList.toggle("is-focused", win.spec.id === this.focusedId);
    }
  }

  private min(win: Win): Size {
    return win.spec.min ?? DEFAULT_MIN;
  }

  private layout(): void {
    this.area = { w: this.layer.clientWidth, h: this.layer.clientHeight };
    this.layer.classList.toggle("is-compact", this.compact);
    for (const win of this.windows.values()) this.apply(win);
  }

  private apply(win: Win): void {
    win.el.hidden = win.visibility !== "open";
    const full = win.maximized || this.compact;
    win.el.classList.toggle("is-max", full);
    const label = win.maximized ? "Restaurar" : "Maximizar";
    win.maxButton.textContent = win.maximized ? "❐" : "□";
    win.maxButton.title = label;
    win.maxButton.setAttribute("aria-label", label);

    if (full) {
      Object.assign(win.el.style, { left: "0", top: "0", width: "100%", height: "100%" });
      return;
    }
    if (this.area.w === 0) return;
    win.rect = fitRect(
      win.rect ?? cascadeRect(win.index, win.spec.size, this.area),
      this.area,
      this.min(win),
    );
    this.place(win);
  }

  private place(win: Win): void {
    const r = win.rect!;
    Object.assign(win.el.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.w}px`,
      height: `${r.h}px`,
    });
  }

  private startDrag(win: Win, event: PointerEvent, edge: Edge | null): void {
    if (event.button !== 0) return;
    if (edge === null && (event.target as Element).closest("button")) return;
    if (win.maximized || this.compact || !win.rect) return;

    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const start = win.rect;
    const startX = event.clientX;
    const startY = event.clientY;
    const min = this.min(win);
    let moved = false;
    document.body.classList.add("is-dragging");
    document.body.style.cursor = getComputedStyle(handle).cursor;

    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      moved ||= dx !== 0 || dy !== 0;
      win.rect = edge
        ? resizeRect(start, edge, dx, dy, this.area, min)
        : moveRect(start, dx, dy, this.area);
      this.place(win);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("is-dragging");
      document.body.style.cursor = "";
      if (moved) this.save();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  private commit(): void {
    this.save();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private load(): Record<string, Saved> {
    try {
      const data = JSON.parse(localStorage.getItem(this.storageKey) ?? "{}") as unknown;
      if (typeof data !== "object" || data === null) return {};
      const result: Record<string, Saved> = {};
      for (const [id, raw] of Object.entries(data as Record<string, Record<string, unknown>>)) {
        if (!raw || !VISIBILITIES.has(raw.visibility as Visibility)) continue;
        result[id] = {
          visibility: raw.visibility as Visibility,
          maximized: raw.maximized === true,
          rect: isRect(raw.rect) ? raw.rect : null,
        };
      }
      return result;
    } catch {
      return {};
    }
  }

  private save(): void {
    const data: Record<string, Saved> = {};
    for (const [id, win] of this.windows) {
      data[id] = { visibility: win.visibility, maximized: win.maximized, rect: win.rect };
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch {
      // Sem armazenamento (aba anônima, bloqueio): as janelas só não lembram o lugar.
    }
  }
}
