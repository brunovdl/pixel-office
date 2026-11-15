/** Planta do escritório em tiles e busca de caminho. Sem dependência de DOM. */

export const TILE = 16;
export const COLS = 20;
export const ROWS = 13;
export const WIDTH = COLS * TILE;
export const HEIGHT = ROWS * TILE;

/** Linhas ocupadas pela parede do fundo. */
export const WALL_ROWS = 2;

export interface Tile {
  col: number;
  row: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Cada mesa ocupa dois tiles: (col, row) e (col + 1, row). */
export const DESKS: readonly Tile[] = [5, 9].flatMap((row) =>
  [1, 5, 9, 13].map((col) => ({ col, row })),
);

/** Móveis de um tile que bloqueiam a passagem. */
export const FURNITURE = {
  bookshelf: [
    { col: 0, row: 2 },
    { col: 1, row: 2 },
  ],
  coffee: [
    { col: 17, row: 2 },
    { col: 18, row: 2 },
  ],
  plants: [
    { col: 19, row: 2 },
    { col: 0, row: 12 },
  ],
  cooler: [{ col: 19, row: 7 }],
} as const satisfies Record<string, readonly Tile[]>;

/** Onde os agentes ficam quando não têm trabalho. */
export const IDLE_SPOTS: readonly Tile[] = [
  { col: 16, row: 3 },
  { col: 17, row: 3 },
  { col: 18, row: 4 },
  { col: 17, row: 5 },
  { col: 18, row: 6 },
  { col: 4, row: 11 },
  { col: 7, row: 11 },
  { col: 9, row: 12 },
  { col: 11, row: 11 },
  { col: 14, row: 11 },
  { col: 16, row: 10 },
];

/** Tile por onde os agentes entram. */
export const ENTRANCE: Tile = { col: 19, row: 10 };

const key = (t: Tile) => t.row * COLS + t.col;

const blocked = new Set<number>();
for (const desk of DESKS) {
  blocked.add(key(desk));
  blocked.add(key({ col: desk.col + 1, row: desk.row }));
}
for (const tiles of Object.values(FURNITURE)) {
  for (const t of tiles) blocked.add(key(t));
}

export function inBounds(t: Tile): boolean {
  return t.col >= 0 && t.col < COLS && t.row >= 0 && t.row < ROWS;
}

export function isWalkable(t: Tile): boolean {
  return inBounds(t) && t.row >= WALL_ROWS && !blocked.has(key(t));
}

export function tileOf(p: Point): Tile {
  return { col: Math.floor(p.x / TILE), row: Math.floor(p.y / TILE) };
}

/** Ponto onde ficam os pés de quem está parado no tile. */
export function standPoint(t: Tile): Point {
  return { x: t.col * TILE + TILE / 2, y: t.row * TILE + 12 };
}

/** Tile da cadeira: atrás da mesa, de frente para a câmera. */
export function seatTile(desk: Tile): Tile {
  return { col: desk.col + 1, row: desk.row - 1 };
}

/** Ponto dos pés de quem está sentado; fica sob o tampo da mesa. */
export function seatPoint(desk: Tile): Point {
  return { x: (desk.col + 1) * TILE, y: desk.row * TILE + 4 };
}

const NEIGHBORS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/**
 * Menor caminho em passos ortogonais, sem incluir o tile de partida.
 * A partida pode estar bloqueada (agente saindo da mesa); o destino não.
 * Devolve null se não houver caminho.
 */
export function findPath(from: Tile, to: Tile): Tile[] | null {
  if (!isWalkable(to)) return null;
  if (from.col === to.col && from.row === to.row) return [];

  const cameFrom = new Map<number, Tile>();
  const visited = new Set<number>([key(from)]);
  const queue: Tile[] = [from];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    for (const [dc, dr] of NEIGHBORS) {
      const next = { col: current.col + dc, row: current.row + dr };
      if (!isWalkable(next) || visited.has(key(next))) continue;
      visited.add(key(next));
      cameFrom.set(key(next), current);
      if (next.col === to.col && next.row === to.row) {
        const path = [next];
        let step = current;
        while (step !== from) {
          path.push(step);
          step = cameFrom.get(key(step))!;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}
