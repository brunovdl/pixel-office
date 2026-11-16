/**
 * Markdown simples para o texto das specs: títulos, parágrafos, listas, blocos
 * de código, `código` e **negrito**. Todo texto entra como texto, nunca como HTML.
 */

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push({ kind: "list", ...list });
    paragraph = [];
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("```")) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith("```"); i++) {
        code.push(lines[i]!);
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: heading[2]!.trim() });
      continue;
    }

    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[3]!.trim());
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export type Inline = { kind: "text" | "code" | "strong"; text: string };

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) parts.push({ kind: "code", text: match[1] });
    else parts.push({ kind: "strong", text: match[2]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

function inline(parent: HTMLElement, text: string): HTMLElement {
  for (const part of parseInline(text)) {
    if (part.kind === "text") parent.append(document.createTextNode(part.text));
    else {
      const node = document.createElement(part.kind === "code" ? "code" : "strong");
      node.textContent = part.text;
      parent.append(node);
    }
  }
  return parent;
}

export function renderMarkdown(source: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "md";
  for (const block of parseBlocks(source)) {
    if (block.kind === "heading") {
      root.append(inline(document.createElement(`h${block.level + 2}`), block.text));
    } else if (block.kind === "paragraph") {
      root.append(inline(document.createElement("p"), block.text));
    } else if (block.kind === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) list.append(inline(document.createElement("li"), item));
      root.append(list);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = block.text;
      root.append(pre);
    }
  }
  return root;
}
