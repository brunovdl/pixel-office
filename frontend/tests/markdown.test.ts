import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/markdown";

describe("parseBlocks", () => {
  it("separa títulos, parágrafos, listas e código", () => {
    const source = [
      "# Objetivo",
      "Primeira linha",
      "continua aqui.",
      "",
      "- um",
      "- dois",
      "1. primeiro",
      "2) segundo",
      "#### Detalhe",
      "```",
      "const x = 1;",
      "  <b>texto</b>",
      "```",
      "Fim",
    ].join("\n");
    expect(parseBlocks(source)).toEqual([
      { kind: "heading", level: 1, text: "Objetivo" },
      { kind: "paragraph", text: "Primeira linha continua aqui." },
      { kind: "list", ordered: false, items: ["um", "dois"] },
      { kind: "list", ordered: true, items: ["primeiro", "segundo"] },
      { kind: "heading", level: 3, text: "Detalhe" },
      { kind: "code", text: "const x = 1;\n  <b>texto</b>" },
      { kind: "paragraph", text: "Fim" },
    ]);
  });

  it("aceita texto vazio e bloco de código sem fechamento", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("```\nsolto")).toEqual([{ kind: "code", text: "solto" }]);
  });
});

describe("parseInline", () => {
  it("reconhece código e negrito e mantém o resto como texto", () => {
    expect(parseInline("Use `npm test` e **sempre** rode <script>")).toEqual([
      { kind: "text", text: "Use " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " e " },
      { kind: "strong", text: "sempre" },
      { kind: "text", text: " rode <script>" },
    ]);
  });
});
