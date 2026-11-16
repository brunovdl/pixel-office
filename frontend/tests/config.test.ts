import { describe, expect, it, vi } from "vitest";
import { ConfigApi, isSlug, parseArgs, secretPayload, slugify, toolReady, type CredentialConfig } from "../src/config";

describe("slugify", () => {
  it("gera id a partir do nome", () => {
    expect(slugify("Especialista de Dados")).toBe("especialista-de-dados");
    expect(slugify("  Ação & Reação!  ")).toBe("acao-reacao");
    expect(slugify("x".repeat(40))).toHaveLength(32);
    expect(slugify("abc-".repeat(10))).not.toMatch(/-$/);
  });

  it("isSlug segue a regra do backend", () => {
    expect(isSlug("dados_2")).toBe(true);
    for (const bad of ["", "Dados", "-x", "com espaço", "a".repeat(33)]) expect(isSlug(bad)).toBe(false);
  });
});

it("parseArgs lê um argumento por linha", () => {
  expect(parseArgs(" -y \n\n@pkg/server  \n")).toEqual(["-y", "@pkg/server"]);
});

describe("secretPayload", () => {
  it("valor digitado substitui, vazio mantém o salvo, linha vazia é ignorada", () => {
    expect(
      secretPayload([
        { name: "TOKEN", value: "", kept: true },
        { name: "LOG_LEVEL", value: "debug", kept: false },
        { name: "", value: "", kept: false },
      ]),
    ).toEqual({ TOKEN: null, LOG_LEVEL: "debug" });
  });

  it("aponta valor faltando, nome inválido e nome repetido", () => {
    expect(secretPayload([{ name: "NOVO", value: "", kept: false }])).toBe("Informe o valor de NOVO.");
    expect(secretPayload([{ name: "com espaço", value: "x", kept: false }])).toMatch(/Nome inválido/);
    expect(
      secretPayload([
        { name: "A", value: "1", kept: false },
        { name: "A", value: "2", kept: false },
      ]),
    ).toBe("Nome repetido: A");
  });
});

describe("ConfigApi", () => {
  it("monta a URL da logo com token e versão", () => {
    expect(new ConfigApi("http://h:8000/ws", "segredo").logoUrl(5)).toBe(
      "http://h:8000/api/config/logo?token=segredo&v=5",
    );
    expect(new ConfigApi("http://h:8000/ws", null).logoUrl(5)).toBe("http://h:8000/api/config/logo?v=5");
  });

  it("envia a logo como binário com o tipo do arquivo", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ name: "x" }), { status: 200 }));
    const api = new ConfigApi("http://h/", "t", fetcher as typeof fetch);
    const file = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    await api.uploadLogo(file);
    expect(fetcher).toHaveBeenCalledWith("http://h/api/config/logo", {
      method: "PUT",
      headers: { "Content-Type": "image/png", Authorization: "Bearer t" },
      body: file,
    });
  });

  it("salva chave sem esperar corpo de volta", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new ConfigApi("http://h/", null, fetcher as typeof fetch);
    await expect(api.setKey("cursor", "key_1")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("http://h/api/config/keys/cursor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"value":"key_1"}',
    });
  });
});

describe("toolReady", () => {
  const credential = (id: CredentialConfig["id"], tool: CredentialConfig["tool"], configured: boolean): CredentialConfig => ({
    id,
    tool,
    configured,
    label: id,
    env: "X",
    hint: null,
    updatedAt: null,
  });

  it("exige credencial para Claude Code e Cursor, e qualquer uma das duas do Claude basta", () => {
    const none = [credential("claude_oauth", "claude_code", false), credential("anthropic", "claude_code", false)];
    expect(toolReady("claude_code", none)).toBe(false);
    expect(toolReady("claude_code", [...none, credential("anthropic", "claude_code", true)])).toBe(true);
    expect(toolReady("cursor", none)).toBe(false);
  });

  it("Antigravity pode rodar com o login salvo", () => {
    expect(toolReady("antigravity", [])).toBe(true);
  });
});
