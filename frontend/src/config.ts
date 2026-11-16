/** Configuração do escritório: tipos, cliente da API e regras dos formulários. Sem DOM. */

import { ApiClient } from "./board";

export type ProviderId = "anthropic" | "claude_oauth" | "groq" | "openai" | "google";
export const PROMPT_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface OfficeConfig {
  name: string;
  masterPrompt: string;
  promptFiles: PromptFile[];
  logo: { mime: string; updatedAt: number } | null;
}

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  configured: boolean;
  hint: string | null;
  updatedAt: number | null;
}

export interface SecretHint {
  name: string;
  hint: string;
}

export interface McpConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  env: SecretHint[];
  headers: SecretHint[];
  enabled: boolean;
  updatedAt: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  prompt: string;
  provider: ProviderId | null;
  model: string;
  mcps: string[];
  enabled: boolean;
  updatedAt: number;
}

export interface PublicConfig {
  office: OfficeConfig;
  providers: ProviderConfig[];
  mcps: McpConfig[];
  agents: AgentConfig[];
}

export const EMPTY_CONFIG: PublicConfig = {
  office: { name: "Pixel Office", masterPrompt: "", promptFiles: [], logo: null },
  providers: [],
  mcps: [],
  agents: [],
};

export type McpInput = Partial<Omit<McpConfig, "env" | "headers" | "updatedAt">> & {
  env?: Record<string, string | null>;
  headers?: Record<string, string | null>;
};
export type AgentInput = Partial<Omit<AgentConfig, "updatedAt">>;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export function isSlug(text: string): boolean {
  return SLUG.test(text);
}

/** Id a partir do nome: "Especialista de Dados" → "especialista-de-dados". */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** Argumentos do comando, um por linha. */
export function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Linha do editor de segredos. `kept`: já existe valor salvo no servidor. */
export interface SecretRow {
  name: string;
  value: string;
  kept: boolean;
}

/**
 * Mapa para a API: valor digitado substitui, campo vazio mantém o salvo (null),
 * linha removida some. Devolve o texto do erro se algo estiver inválido.
 */
export function secretPayload(rows: readonly SecretRow[]): Record<string, string | null> | string {
  const result: Record<string, string | null> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name && !row.value) continue;
    if (!SECRET_NAME.test(name)) return `Nome inválido: "${name}". Use letras, números, _ e -.`;
    if (name in result) return `Nome repetido: ${name}`;
    if (row.value) result[name] = row.value;
    else if (row.kept) result[name] = null;
    else return `Informe o valor de ${name}.`;
  }
  return result;
}

export class ConfigApi extends ApiClient {
  logoUrl(updatedAt: number): string {
    return `${this.url("/api/config/logo", true)}${this.token ? "&" : "?"}v=${updatedAt}`;
  }

  saveOffice(data: Omit<OfficeConfig, "logo">): Promise<OfficeConfig> {
    return this.request("PUT", "/api/config/office", data) as Promise<OfficeConfig>;
  }

  uploadLogo(file: Blob): Promise<OfficeConfig> {
    return this.request("PUT", "/api/config/logo", file) as Promise<OfficeConfig>;
  }

  async deleteLogo(): Promise<void> {
    await this.request("DELETE", "/api/config/logo");
  }

  async setKey(provider: ProviderId, value: string): Promise<void> {
    await this.request("PUT", `/api/config/keys/${provider}`, { value });
  }

  async deleteKey(provider: ProviderId): Promise<void> {
    await this.request("DELETE", `/api/config/keys/${provider}`);
  }

  createMcp(data: McpInput): Promise<McpConfig> {
    return this.request("POST", "/api/config/mcps", data) as Promise<McpConfig>;
  }

  updateMcp(id: string, data: McpInput): Promise<McpConfig> {
    return this.request("PATCH", `/api/config/mcps/${id}`, data) as Promise<McpConfig>;
  }

  async deleteMcp(id: string): Promise<void> {
    await this.request("DELETE", `/api/config/mcps/${id}`);
  }

  createAgent(data: AgentInput): Promise<AgentConfig> {
    return this.request("POST", "/api/config/agents", data) as Promise<AgentConfig>;
  }

  updateAgent(id: string, data: AgentInput): Promise<AgentConfig> {
    return this.request("PATCH", `/api/config/agents/${id}`, data) as Promise<AgentConfig>;
  }

  async deleteAgent(id: string): Promise<void> {
    await this.request("DELETE", `/api/config/agents/${id}`);
  }
}
