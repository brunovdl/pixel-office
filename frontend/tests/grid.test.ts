import { describe, expect, it } from "vitest";
import {
  COLS,
  DESKS,
  ENTRANCE,
  IDLE_SPOTS,
  ROWS,
  findPath,
  isWalkable,
  seatPoint,
  seatTile,
  standPoint,
  tileOf,
  type Tile,
} from "../src/grid";

function expectValidPath(from: Tile, path: Tile[] | null, to: Tile): void {
  expect(path).not.toBeNull();
  let previous = from;
  for (const tile of path!) {
    expect(isWalkable(tile)).toBe(true);
    expect(Math.abs(tile.col - previous.col) + Math.abs(tile.row - previous.row)).toBe(1);
    previous = tile;
  }
  expect(previous).toEqual(to);
}

describe("planta", () => {
  it("tem oito mesas bloqueadas com cadeira livre", () => {
    expect(DESKS).toHaveLength(8);
    for (const desk of DESKS) {
      expect(isWalkable(desk)).toBe(false);
      expect(isWalkable({ col: desk.col + 1, row: desk.row })).toBe(false);
      expect(isWalkable(seatTile(desk))).toBe(true);
    }
  });

  it("bloqueia a parede e o que está fora dos limites", () => {
    expect(isWalkable({ col: 5, row: 0 })).toBe(false);
    expect(isWalkable({ col: 5, row: 1 })).toBe(false);
    expect(isWalkable({ col: -1, row: 5 })).toBe(false);
    expect(isWalkable({ col: COLS, row: 5 })).toBe(false);
    expect(isWalkable({ col: 5, row: ROWS })).toBe(false);
  });

  it("tem entrada e pontos de descanso livres e sem repetição", () => {
    expect(isWalkable(ENTRANCE)).toBe(true);
    for (const spot of IDLE_SPOTS) expect(isWalkable(spot)).toBe(true);
    const unique = new Set(IDLE_SPOTS.map((s) => `${s.col},${s.row}`));
    expect(unique.size).toBe(IDLE_SPOTS.length);
  });

  it("converte entre ponto e tile", () => {
    const tile = { col: 7, row: 9 };
    expect(tileOf(standPoint(tile))).toEqual(tile);
  });
});

describe("findPath", () => {
  it("devolve caminho vazio quando já está no destino", () => {
    expect(findPath(ENTRANCE, ENTRANCE)).toEqual([]);
  });

  it("liga a entrada a todas as cadeiras e pontos de descanso", () => {
    for (const desk of DESKS) expectValidPath(ENTRANCE, findPath(ENTRANCE, seatTile(desk)), seatTile(desk));
    for (const spot of IDLE_SPOTS) expectValidPath(ENTRANCE, findPath(ENTRANCE, spot), spot);
  });

  it("acha o caminho mais curto em área aberta", () => {
    expect(findPath({ col: 3, row: 6 }, { col: 8, row: 7 })).toHaveLength(6);
  });

  it("contorna a mesa em vez de atravessar", () => {
    const desk = DESKS[0]!;
    const below = { col: desk.col, row: desk.row + 1 };
    const path = findPath(seatTile(desk), below);
    expectValidPath(seatTile(desk), path, below);
    expect(path!.length).toBeGreaterThan(2);
  });

  it("recusa destino bloqueado", () => {
    expect(findPath(ENTRANCE, DESKS[0]!)).toBeNull();
  });

  it("aceita partida bloqueada, como quem levanta da mesa", () => {
    const desk = DESKS[3]!;
    const start = tileOf(seatPoint(desk));
    expect(isWalkable(start)).toBe(false);
    expect(findPath(start, IDLE_SPOTS[0]!)).not.toBeNull();
  });
});
