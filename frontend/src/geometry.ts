/** Contas de posição e tamanho das janelas. Sem dependência de DOM. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Borda ou canto puxado ao redimensionar. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Mantém a janela inteira dentro da área e não menor que o mínimo (se couber). */
export function fitRect(rect: Rect, area: Size, min: Size): Rect {
  const w = clamp(rect.w, Math.min(min.w, area.w), area.w);
  const h = clamp(rect.h, Math.min(min.h, area.h), area.h);
  return { w, h, x: clamp(rect.x, 0, area.w - w), y: clamp(rect.y, 0, area.h - h) };
}

/** Arrasta a janela sem deixar que saia da área. */
export function moveRect(start: Rect, dx: number, dy: number, area: Size): Rect {
  return {
    ...start,
    x: clamp(start.x + dx, 0, area.w - start.w),
    y: clamp(start.y + dy, 0, area.h - start.h),
  };
}

/**
 * Redimensiona puxando uma borda ou canto. A borda oposta fica parada, a janela
 * não fica menor que o mínimo e não passa dos limites da área.
 */
export function resizeRect(
  start: Rect,
  edge: Edge,
  dx: number,
  dy: number,
  area: Size,
  min: Size,
): Rect {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (edge.includes("w")) {
    x = clamp(start.x + dx, 0, right - min.w);
    w = right - x;
  }
  if (edge.includes("e")) w = clamp(start.w + dx, min.w, area.w - start.x);
  if (edge.includes("n")) {
    y = clamp(start.y + dy, 0, bottom - min.h);
    h = bottom - y;
  }
  if (edge.includes("s")) h = clamp(start.h + dy, min.h, area.h - start.y);
  return { x, y, w, h };
}

/** Posição inicial: centralizada, deslocada em cascata para não empilhar. */
export function cascadeRect(index: number, size: Size, area: Size): Rect {
  const w = Math.min(size.w, area.w - 32);
  const h = Math.min(size.h, area.h - 32);
  const offset = (index - 1) * 28;
  return {
    x: Math.round((area.w - w) / 2 + offset),
    y: Math.round(Math.max(12, (area.h - h) / 2 - 24) + offset),
    w,
    h,
  };
}
