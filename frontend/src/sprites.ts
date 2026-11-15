/** Sprites desenhados por código. Nenhuma imagem externa é usada. */

import type { Look } from "./look";

export type Frame = "stand" | "walkA" | "walkB";

export const SPRITE_W = 10;
export const SPRITE_H = 15;

// h cabelo, s pele, e olho, c camisa, p calça, w sapato, . transparente
const HEADS: Record<0 | 1, string[]> = {
  0: [
    "...hhhh...",
    "..hhhhhh..",
    ".hhhhhhhh.",
    ".hhsssshh.",
    ".ssessess.",
    ".ssssssss.",
    "..ssssss..",
  ],
  1: [
    "..hhhhhh..",
    ".hhhhhhhh.",
    "hhhhhhhhhh",
    "hhhsssshhh",
    "hssessessh",
    "hssssssssh",
    "hhsssssshh",
  ],
};

const TORSO = [".cccccccc.", "cccccccccc", "sccccccccs", ".cccccccc.", "..pppppp.."];

const LEGS: Record<Frame, string[]> = {
  stand: ["..pp..pp..", "..pp..pp..", "..ww..ww.."],
  walkA: ["..pp..pp..", "..pp..ww..", "..ww......"],
  walkB: ["..pp..pp..", "..ww..pp..", "......ww.."],
};

function paint(rows: string[], palette: Record<string, string>): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_W;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d")!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[row[x]!];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return canvas;
}

export type CharacterSprites = Record<Frame, HTMLCanvasElement>;

export function buildCharacter(look: Look): CharacterSprites {
  const palette = {
    h: look.hair,
    s: look.skin,
    e: "#1d1d24",
    c: look.shirt,
    p: look.pants,
    w: "#22222a",
  };
  const frame = (name: Frame) =>
    paint([...HEADS[look.style], ...TORSO, ...LEGS[name]], palette);
  return { stand: frame("stand"), walkA: frame("walkA"), walkB: frame("walkB") };
}

/** Glifos dos balões, em bitmaps de 5 linhas. */
export const GLYPHS = {
  question: ["##.", "..#", ".#.", "...", ".#."],
  exclamation: ["#", "#", "#", ".", "#"],
  check: ["....#", "...#.", "#.#..", ".#...", "....."],
} as const;

export type GlyphName = keyof typeof GLYPHS;

export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  name: GlyphName,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color;
  GLYPHS[name].forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      if (row[dx] === "#") ctx.fillRect(x + dx, y + dy, 1, 1);
    }
  });
}
