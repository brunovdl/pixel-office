/** Aparência dos agentes. Sem dependência de DOM, para a tela e o painel usarem. */

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  /** 0 = cabelo curto, 1 = cabelo comprido. */
  style: 0 | 1;
}

const SHIRTS = [
  "#e5484d",
  "#3e9bff",
  "#46c36f",
  "#f5a524",
  "#a26bf5",
  "#17c3b2",
  "#f06bb0",
  "#e8e3d3",
];
const SKINS = ["#f6d3b3", "#e8b98f", "#c68f63", "#8d5a3b"];
const HAIRS = ["#2b2118", "#5a3a22", "#a8652d", "#d8b25a", "#7d7d86", "#b23a2e"];
const PANTS = ["#2e3a55", "#3b3b46", "#4a3b32"];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Cor da camisa: distinta para os oito primeiros agentes. */
export function shirtColor(seq: number): string {
  return SHIRTS[seq % SHIRTS.length]!;
}

export function lookFor(id: string, seq: number): Look {
  const h = hash(id);
  return {
    shirt: shirtColor(seq),
    skin: SKINS[h % SKINS.length]!,
    hair: HAIRS[(h >>> 4) % HAIRS.length]!,
    pants: PANTS[(h >>> 8) % PANTS.length]!,
    style: ((h >>> 12) % 2) as 0 | 1,
  };
}
