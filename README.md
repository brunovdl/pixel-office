# pixel-office

Harness de desenvolvimento assistido por IA: um time de agentes trabalhando em um
repositório, mostrado como um escritório em pixel.

![Escritório com os agentes trabalhando](docs/escritorio.png)

## Estado atual

Só o escritório existe, alimentado por um simulador. Nenhum provedor de IA está
ligado ainda e não há backend.

| Parte | Situação |
| --- | --- |
| Escritório em pixel (frontend) | Funciona com eventos simulados |
| Protocolo de eventos | Definido em `frontend/src/events.ts` |
| Backend em Python | Não começou |
| Adaptador Groq | Não começou |
| Adaptador Claude Code | Não começou |

## Como rodar

Requer Node 20 ou mais novo.

```bash
cd frontend
npm install
npm run dev
```

Abra `http://localhost:5173`. Use `?seed=5` na URL para repetir a mesma simulação.

Outros comandos, dentro de `frontend/`:

```bash
npm test          # testes (vitest)
npm run typecheck # tsc sem emitir arquivos
npm run build     # typecheck + build de produção em dist/
```

## Como funciona

O escritório não conhece nenhum provedor. Ele consome uma lista de eventos em um
formato único, e cada provedor será traduzido para esse formato.

```
origem de eventos  ->  reduce(estado, evento)  ->  cena + painel
(simulador hoje)       (função pura)               (canvas e HTML)
```

| Arquivo em `frontend/src/` | Papel |
| --- | --- |
| `events.ts` | Tipos dos eventos e a interface `EventFeed` |
| `state.ts` | Máquina de estados dos agentes (`reduce`) |
| `grid.ts` | Planta do escritório e busca de caminho |
| `simulator.ts` | Time falso que gera eventos, com semente |
| `scene.ts` | Desenho do escritório e movimento dos agentes |
| `sprites.ts`, `look.ts` | Personagens desenhados por código, sem imagens |
| `panel.ts` | Lista do time e registro de eventos |

### Eventos

Todo evento tem `ts` (ms) e `agentId`.

| Evento | Campos | Efeito no agente |
| --- | --- | --- |
| `agent_joined` | `name`, `role` | Entra no escritório, livre |
| `agent_left` | | Sai do escritório |
| `task_started` | `task` | Pensando |
| `thinking` | | Pensando |
| `tool_started` | `tool`, `detail?` | Lendo, editando ou executando, conforme a ferramenta |
| `tool_finished` | `tool`, `ok` | Pensando (falha de ferramenta não é erro do agente) |
| `message` | `text` | Só muda o texto mostrado |
| `waiting_decision` | `question` | Aguardando decisão do usuário |
| `decision_answered` | | Pensando |
| `task_finished` | `ok` | Concluiu ou erro |
| `error` | `message` | Erro |

Os nomes de ferramenta seguem os do Claude Code (`Read`, `Grep`, `Glob`, `Edit`,
`Write`, `Bash`). Ferramenta desconhecida aparece como "executando".

### O que o escritório mostra

- Agente com trabalho vai para a própria mesa; livre, circula pela copa e pelo tapete.
- O monitor da mesa muda conforme o status (leitura, edição, terminal).
- Balões: `...` pensando, `?` aguardando decisão, `!` erro, `✓` concluiu.
- O quadro "DECISÕES" na parede ganha uma nota por decisão pendente.
- No painel, "Responder" libera o agente que aguarda decisão (no simulador, a
  decisão também se resolve sozinha em 20 segundos).

Há oito mesas. Um nono agente fica sem mesa e trabalha em pé.

## Próximos passos

1. Backend em Python que publica os eventos por WebSocket, no lugar do simulador.
2. Adaptador Groq: loop de agente com ferramentas, emitindo estes eventos.
3. Adaptador Claude Code: executa o `claude` e traduz a saída para estes eventos.
