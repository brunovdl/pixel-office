/**
 * Gera eventos falsos de um time de agentes, para desenvolver a tela sem provedor.
 * É determinístico: mesma semente e mesmos ticks produzem os mesmos eventos.
 */

import type { AgentEvent, EventFeed, EventListener } from "./events";

interface Member {
  id: string;
  name: string;
  role: string;
  tasks: string[];
  /** Ferramentas com repetição proporcional à frequência de uso. */
  tools: string[];
}

const TEAM: Member[] = [
  {
    id: "orq",
    name: "Orquestrador",
    role: "Coordena o time",
    tasks: ["Planejar a sprint", "Distribuir tarefas do backlog", "Revisar o andamento"],
    tools: ["Read", "Read", "Grep", "Write"],
  },
  {
    id: "spec",
    name: "Especificador",
    role: "Escreve as specs",
    tasks: ["Escrever spec de login", "Detalhar critérios de aceite", "Revisar spec de relatórios"],
    tools: ["Read", "Grep", "Write", "Edit", "Edit"],
  },
  {
    id: "be",
    name: "Dev Backend",
    role: "API e dados",
    tasks: ["Criar endpoint de sessões", "Corrigir validação de entrada", "Adicionar migração"],
    tools: ["Read", "Grep", "Edit", "Edit", "Write", "Bash"],
  },
  {
    id: "fe",
    name: "Dev Frontend",
    role: "Telas",
    tasks: ["Montar tela de cadastro", "Ajustar layout responsivo", "Ligar formulário à API"],
    tools: ["Read", "Glob", "Edit", "Edit", "Write", "Bash"],
  },
  {
    id: "qa",
    name: "QA",
    role: "Testes",
    tasks: ["Rodar a suíte de testes", "Escrever teste de regressão", "Validar critérios de aceite"],
    tools: ["Read", "Bash", "Bash", "Bash", "Edit"],
  },
  {
    id: "rev",
    name: "Code Reviewer",
    role: "Revisão de código",
    tasks: ["Revisar PR de sessões", "Revisar PR de cadastro", "Conferir cobertura de testes"],
    tools: ["Read", "Read", "Read", "Grep", "Bash"],
  },
];

const FILES = [
  "src/api/sessions.py",
  "src/api/users.py",
  "src/models/user.py",
  "web/src/pages/Signup.tsx",
  "web/src/components/Form.tsx",
  "tests/test_sessions.py",
  "docs/specs/003-login.md",
  "README.md",
];
const COMMANDS = ["pytest -q", "npm test", "npm run typecheck", "git diff --stat", "ruff check ."];
const PATTERNS = ["def create_", "TODO", "useEffect", "class .*Error"];
const MESSAGES = [
  "Entendi o problema, vou ajustar.",
  "Os testes passaram.",
  "Achei o ponto que precisa mudar.",
  "Falta cobrir um caso de borda.",
];
const QUESTIONS = [
  "Posso apagar a tabela antiga?",
  "Uso sessão por cookie ou por token?",
  "Sigo sem o teste de integração?",
  "Mantenho compatibilidade com a versão anterior?",
];

/** O gerador devolve quanto esperar (ms) ou pede uma decisão com prazo (ms). */
type Step = number | { decisionTimeout: number };

interface Runner {
  id: string;
  script: Generator<Step, void, void>;
  wakeAt: number;
  /** Prazo da decisão pendente, ou null se não está esperando. */
  waitingUntil: number | null;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorOptions {
  seed?: number;
  /** Horário do primeiro evento, em ms. */
  startTs?: number;
}

export class Simulator implements EventFeed {
  private readonly listeners = new Set<EventListener>();
  private readonly startTs: number;
  private readonly runners: Runner[];
  /** Tempo simulado decorrido, em ms. */
  private now = 0;
  /** Tempo simulado do evento sendo emitido. */
  private clock = 0;

  constructor(options: SimulatorOptions = {}) {
    const seed = options.seed ?? 1;
    this.startTs = options.startTs ?? Date.now();
    this.runners = TEAM.map((member, index) => {
      // Gerador próprio, para a sequência do agente não depender dos outros.
      const random = mulberry32(seed * 31 + index);
      return {
        id: member.id,
        script: this.script(member, random),
        wakeAt: 400 + index * 700,
        waitingUntil: null,
      };
    });
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Avança o tempo simulado e emite, em ordem de tempo, os eventos que vencerem. */
  tick(dtMs: number): void {
    this.now += dtMs;
    for (;;) {
      let next: Runner | null = null;
      for (const runner of this.runners) {
        if (dueAt(runner) <= this.now && (!next || dueAt(runner) < dueAt(next))) next = runner;
      }
      if (!next) return;
      this.advance(next);
    }
  }

  /** Responde a decisão pendente do agente. Devolve false se não havia. */
  answerDecision(agentId: string): boolean {
    const runner = this.runners.find((r) => r.id === agentId);
    if (!runner || runner.waitingUntil === null) return false;
    this.resolveDecision(runner, this.now);
    return true;
  }

  /** Executa um passo do agente, que já está vencido. */
  private advance(runner: Runner): void {
    if (runner.waitingUntil !== null) {
      this.resolveDecision(runner, runner.waitingUntil);
      return;
    }
    this.clock = runner.wakeAt;
    const result = runner.script.next();
    if (result.done) runner.wakeAt = Infinity;
    else if (typeof result.value === "number") runner.wakeAt += result.value;
    else runner.waitingUntil = runner.wakeAt + result.value.decisionTimeout;
  }

  private resolveDecision(runner: Runner, at: number): void {
    this.clock = at;
    runner.waitingUntil = null;
    runner.wakeAt = at;
    this.emit({ type: "decision_answered", agentId: runner.id });
  }

  private emit(event: DistributiveOmit<AgentEvent, "ts">): void {
    const full = { ...event, ts: this.startTs + Math.round(this.clock) } as AgentEvent;
    for (const listener of this.listeners) listener(full);
  }

  private *script(member: Member, random: () => number): Generator<Step, void, void> {
    const agentId = member.id;
    const between = (min: number, max: number) => min + random() * (max - min);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const toolDetail = (tool: string) => {
      if (tool === "Bash") return pick(COMMANDS);
      if (tool === "Grep" || tool === "Glob") return pick(PATTERNS);
      return pick(FILES);
    };
    this.emit({ type: "agent_joined", agentId, name: member.name, role: member.role });

    for (;;) {
      yield between(3000, 10000);
      this.emit({ type: "task_started", agentId, task: pick(member.tasks) });
      yield between(1000, 3000);

      const steps = 3 + Math.floor(random() * 5);
      const decisionAt = random() < 0.25 ? Math.floor(random() * steps) : -1;

      for (let i = 0; i < steps; i++) {
        if (i === decisionAt) {
          this.emit({ type: "waiting_decision", agentId, question: pick(QUESTIONS) });
          yield { decisionTimeout: 20000 };
          yield between(800, 2000);
        }
        const tool = pick(member.tools);
        this.emit({ type: "tool_started", agentId, tool, detail: toolDetail(tool) });
        yield between(1500, 5000);
        this.emit({ type: "tool_finished", agentId, tool, ok: random() < 0.9 });
        if (random() < 0.3) {
          this.emit({ type: "message", agentId, text: pick(MESSAGES) });
        }
        yield between(800, 2500);
      }

      if (random() < 0.9) {
        this.emit({ type: "task_finished", agentId, ok: true });
      } else {
        this.emit({ type: "error", agentId, message: "Limite de tentativas atingido" });
        yield 4000;
        this.emit({ type: "task_finished", agentId, ok: false });
        yield 3000;
      }
    }
  }
}

function dueAt(runner: Runner): number {
  return runner.waitingUntil ?? runner.wakeAt;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
