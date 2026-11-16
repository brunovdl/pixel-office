# pixel-office

Harness de desenvolvimento assistido por IA: um time de agentes trabalhando em um
repositório, mostrado como um escritório em pixel.

![Escritório com os agentes trabalhando](docs/escritorio.png)

## Estado atual

O escritório recebe eventos do backend por WebSocket. Agentes com o Claude Code
como ferramenta trabalham de verdade no servidor; Cursor e Antigravity ainda não
têm integração. Com `--simulate`, os agentes sem ferramenta viram um time simulado.

| Parte | Situação |
| --- | --- |
| Escritório em pixel (`frontend/`) | Funciona, ligado ao backend, com janelas flutuantes |
| Backend em Python (`backend/`) | Funciona: estado, WebSocket, entrada de eventos por HTTP, tarefas, specs e configuração em SQLite |
| Configurações | Funciona: nome, logo, prompt mestre, credenciais, MCPs e agentes |
| Protocolo de eventos | `backend/pixel_office/events.py` e `frontend/src/events.ts` |
| Integração com Claude Code | Funciona no servidor (`claude -p`), sem ponte de decisões |
| Integração com Cursor | Não começou |
| Integração com Antigravity | Não começou |

## Como rodar

Requer Python 3.11+ e Node 20+. São dois terminais.

Backend, com o time simulado:

```bash
cd backend
python -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pixel_office --simulate
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Abra `http://localhost:5173`. O servidor de desenvolvimento repassa `/ws` e `/api`
para o backend na porta 8000.

Para usar um processo só, rode `npm run build` em `frontend/`: o backend passa a
servir a tela em `http://localhost:8000`.

Sem backend, `http://localhost:5173/?sim` roda um simulador dentro do navegador
(`&seed=5` repete a mesma simulação).

### Opções do backend

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `--simulate` | desligado | Roda o time simulado |
| `--speed N` | 1 | Acelera o simulador |
| `--seed N` | 1 | Semente do simulador |
| `--claude-bin`, `PIXEL_OFFICE_CLAUDE_BIN` | `claude` | Comando do Claude Code no servidor |
| `--db`, `PIXEL_OFFICE_DB` | `backend/data/pixel-office.db` | Arquivo SQLite de tarefas, specs e configuração. Com `--simulate` e sem `--db`, fica só em memória |
| `--host`, `PIXEL_OFFICE_HOST` | `127.0.0.1` | Endereço de escuta |
| `--port`, `PIXEL_OFFICE_PORT` | `8000` | Porta |
| `PIXEL_OFFICE_TOKEN` | sem token | Exige o token no WebSocket e nas rotas de API |
| `PIXEL_OFFICE_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origens de navegador aceitas no WebSocket |

O servidor se recusa a escutar fora de `127.0.0.1` sem `PIXEL_OFFICE_TOKEN`. Com
token, abra a tela com `?token=SEU_TOKEN`.

### Testes

```bash
cd backend && .venv/bin/pytest && .venv/bin/ruff check .
```

```bash
cd frontend && npm test && npm run typecheck
```

## Como funciona

O escritório não conhece nenhuma ferramenta. Tudo passa por um formato único de
eventos, e cada ferramenta (Claude Code, Cursor, Antigravity) terá uma integração
que traduz a saída dela para esse formato.

```
adaptador (simulador hoje) -> Hub -> WebSocket -> reduce(estado, evento) -> cena + painel
   POST /api/events ---------^
```

### Backend (`backend/pixel_office/`)

| Arquivo | Papel |
| --- | --- |
| `events.py` | Modelos e validação dos eventos |
| `state.py` | Estado do escritório derivado dos eventos |
| `hub.py` | Guarda o estado, distribui eventos e controla decisões pendentes |
| `board.py` | Tarefas e specs em SQLite, com validação |
| `config.py` | Configuração: escritório, logo, chaves de API, MCPs e agentes; segredos criptografados |
| `roster.py` | Põe no escritório os agentes ativos da configuração e tira os desativados |
| `executor.py` | Roda o Claude Code nas tarefas dos agentes e publica cada passo |
| `claude_code.py` | Traduz a saída `stream-json` do Claude Code para os eventos |
| `app.py` | Rotas HTTP e o WebSocket |
| `simulator.py` | Time falso que publica no hub |
| `__main__.py` | Linha de comando |

Um adaptador dentro do processo usa o hub direto:

```python
hub.emit("tool_started", "be", tool="Bash", detail="pytest -q")
answer = await hub.request_decision("be", "Posso apagar a tabela antiga?")
```

Um processo externo publica por HTTP (`ts` é opcional):

```bash
curl -X POST localhost:8000/api/events -H 'content-type: application/json' \
  -d '{"type":"agent_joined","agentId":"be","name":"Dev Backend","role":"API"}'
```

| Rota | Uso |
| --- | --- |
| `GET /api/health` | Situação do servidor |
| `GET /api/state` | Estado atual de todos os agentes |
| `POST /api/events` | Publica um evento; 422 com os erros se for inválido |
| `GET/POST /api/tasks` | Lista ou cria tarefas |
| `GET/PATCH/DELETE /api/tasks/{id}` | Lê, altera (só os campos enviados) ou exclui uma tarefa |
| `GET/POST /api/specs` | Lista (resumo, sem o texto) ou cria specs |
| `GET/PATCH/DELETE /api/specs/{id}` | Lê com texto e critérios, altera ou exclui uma spec |
| `GET /api/config` | Configuração sem os segredos (chaves e valores de MCP aparecem só como `…abcd`) |
| `PUT /api/config/office` | Nome, prompt mestre e arquivos em que ele é publicado |
| `PUT /api/config/runner` | Pasta do projeto, permissões, tempo limite, turnos e execuções simultâneas |
| `GET /api/runtime` | Situação do executor: Claude Code instalado, pasta do projeto, execuções em andamento |
| `GET/PUT/DELETE /api/config/logo` | Logo; o envio é o arquivo puro no corpo (PNG, JPEG, WEBP ou GIF, até 2 MB) |
| `PUT/DELETE /api/config/keys/{credencial}` | Credencial de ferramenta: `claude_oauth`, `anthropic`, `cursor`, `gemini` |
| `POST /api/config/mcps`, `PATCH/DELETE /api/config/mcps/{id}` | Servidores MCP; nos segredos, `null` mantém o valor salvo |
| `POST /api/config/agents`, `PATCH/DELETE /api/config/agents/{id}` | Agentes do time |
| `WS /ws` | Estado ao conectar e eventos em seguida |

Mensagens do WebSocket:

| Sentido | Mensagem |
| --- | --- |
| servidor -> tela | `{"kind":"snapshot","agents":[...],"nextSeq":n,"recent":[...]}` ao conectar (`recent` traz os últimos 500 eventos) |
| servidor -> tela | `{"kind":"event","event":{...}}` a cada evento |
| servidor -> tela | `{"kind":"board","tasks":[...],"specs":[...]}` a cada mudança em tarefas ou specs (o snapshot também traz `board`) |
| servidor -> tela | `{"kind":"config",...}` a cada mudança na configuração, sem segredos (o snapshot também traz `config`) |
| servidor -> tela | `{"kind":"error","message":"..."}` quando recusa um comando |
| tela -> servidor | `{"kind":"answer_decision","agentId":"be","answer":"Pode"}` |

A regra que transforma eventos em estado existe em Python e em TypeScript. As duas
rodam os mesmos casos de `shared/reducer-cases.json`; ao mudar uma regra, mude nos
dois lados e nesse arquivo.

### Frontend (`frontend/src/`)

| Arquivo | Papel |
| --- | --- |
| `events.ts` | Tipos dos eventos e a interface `EventFeed` |
| `wsfeed.ts` | Conexão com o backend, com reconexão automática |
| `windows.ts`, `geometry.ts` | Janelas flutuantes: mover, redimensionar, minimizar, maximizar |
| `views.ts` | Conteúdo das janelas (Conversas, Decisões, Agentes) e dos painéis |
| `boardviews.ts`, `board.ts` | Janelas de Tarefas e Specs, filtros e cliente da API |
| `markdown.ts` | Markdown simples do texto das specs, sem HTML |
| `configview.ts`, `config.ts` | Janela de configurações e cliente da API de configuração |
| `history.ts`, `timeline.ts` | Eventos recentes e o histórico de cada agente |
| `ui.ts` | Textos de status, formulário de resposta e utilitários de tela |
| `state.ts` | Máquina de estados dos agentes (`reduce`) |
| `grid.ts` | Planta do escritório e busca de caminho |
| `scene.ts` | Desenho do escritório e movimento dos agentes |
| `sprites.ts`, `look.ts` | Personagens desenhados por código, sem imagens |
| `simulator.ts` | Simulador local do modo `?sim` |

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
| `decision_answered` | `answer?` | Pensando |
| `task_finished` | `ok` | Concluiu ou erro |
| `error` | `message` | Erro |

Os nomes de ferramenta seguem os do Claude Code (`Read`, `Grep`, `Glob`, `Edit`,
`Write`, `Bash`). Ferramenta desconhecida aparece como "executando".

### O que o escritório mostra

- Agente com trabalho vai para a própria mesa; livre, circula pela copa e pelo tapete.
- O monitor da mesa muda conforme o status (leitura, edição, terminal).
- Balões: `...` pensando, `?` aguardando decisão, `!` erro, `✓` concluiu.
- O quadro "DECISÕES" na parede ganha uma nota por decisão pendente.
- Painel da esquerda (recolhível pelo `◀`): status da equipe e log de eventos.
- Barra de baixo: um botão por agente, que abre a conversa dele. Clicar no agente
  dentro do escritório faz o mesmo.

Há oito mesas. Um nono agente fica sem mesa e trabalha em pé.

### Janelas

Os botões no topo abrem as janelas:

| Janela | Conteúdo |
| --- | --- |
| Tarefas | Abas por status com contagem (Ativas, Pendentes, Em andamento, Em revisão, Bloqueadas, Concluídas, Todas), busca por ID, título ou agente, criar, editar e excluir. O botão mostra quantas estão bloqueadas |
| Specs | Abas por status (Rascunho, Aprovada, Em implementação, Implementada), busca, detalhe com critérios de aceite, tarefas ligadas e texto em markdown, botão Aprovar, criar, editar e excluir. O botão mostra quantos rascunhos há |
| Conversas | Histórico de cada agente: tarefas, ferramentas, mensagens, perguntas e respostas. Quando o agente pede decisão, a resposta vai pelo rodapé |
| Decisões | Decisões pendentes com campo de resposta e as respondidas recentemente. O botão mostra quantas estão pendentes. No time simulado, a decisão sem resposta se resolve sozinha em 60 segundos |
| Agentes | Papel, status, tarefa atual e última atividade de cada agente |
| Config | Configurações do escritório, em quatro seções (abaixo) |

Toda janela pode ser:

- movida arrastando a barra de título;
- redimensionada puxando qualquer borda ou canto;
- minimizada (`_`), maximizada ou restaurada (`□`/`❐`, ou duplo clique na barra) e fechada (`✕` ou `Esc`).

Tarefas e specs se ligam: a tarefa mostra sua spec (clique para abrir) e a spec
lista suas tarefas (clique para editar). Excluir pede um segundo clique. Excluir uma
spec mantém as tarefas, sem spec. No time simulado, cada agente pega a tarefa
pendente mais antiga atribuída a ele, inclusive as que você criar.

O botão no topo abre a janela, traz para a frente ou minimiza se ela já estiver em
foco. Posição, tamanho e quais janelas estavam abertas ficam salvos no navegador.
Em telas com menos de 720 px de largura, as janelas ocupam a área inteira.

### Configurações

O botão **⚙ Config** abre o painel de configuração do escritório:

| Seção | O que configura |
| --- | --- |
| Execução | Pasta do projeto no servidor, permissões do Claude Code, tempo limite por tarefa, máximo de turnos e execuções ao mesmo tempo, com a situação do servidor |
| Escritório | Nome (topo e título da aba), logo (topo e quadro na parede do escritório, com envio por botão ou arrastando a imagem) e prompt mestre, com a escolha de publicar como CLAUDE.md, AGENTS.md e GEMINI.md |
| Credenciais | O que cada ferramenta lê: Claude Code (`CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY`), Cursor (`CURSOR_API_KEY`) e Antigravity (`GEMINI_API_KEY`, ou o login de uma sessão interativa) |
| MCPs | Servidores por comando local (stdio, com argumentos e variáveis de ambiente) ou remoto (http, com cabeçalhos) |
| Agentes | Nome, id, papel, ferramenta (Claude Code, Cursor ou Antigravity), modelo, prompt próprio, MCPs que pode usar e se está ativo |

O time do escritório vem da lista de agentes: na primeira execução ela é preenchida
com os seis agentes padrão; agente ativo entra na sala, desativado ou excluído sai,
e renomear muda o nome na hora.

Credenciais e valores de variáveis e cabeçalhos dos MCPs são segredos: ficam
criptografados no banco com a chave de `backend/data/secret.key` (criada na primeira
execução, legível só pelo dono do arquivo) e nunca voltam pela API nem pelo WebSocket;
a tela mostra só os quatro últimos caracteres. Quem tiver o banco **e** o
`secret.key` consegue abrir os segredos, então guarde os dois com o mesmo cuidado. Se
o `secret.key` for perdido, os segredos salvos precisam ser cadastrados de novo.

Para agentes com o Claude Code, ferramenta, modelo, prompts e MCPs valem já (veja
"Executor no servidor"). Para Cursor e Antigravity ficam salvos até a integração
deles existir. O prompt mestre vai para o agente como instrução de sistema; ainda
não é gravado como arquivo no repositório.

### Executor no servidor

O executor procura, a cada poucos segundos e a cada mudança, a tarefa pendente mais
antiga de cada agente ativo cuja ferramenta é o Claude Code. Para rodar, ele precisa
de três coisas, e a seção Execução mostra o que falta:

1. o Claude Code instalado no servidor (`npm install -g @anthropic-ai/claude-code`);
2. a pasta do projeto, um repositório já clonado no servidor;
3. a credencial do Claude Code (token OAuth ou chave da API Anthropic).

Se faltar algo, o agente mostra o motivo no escritório e a tarefa continua pendente.
Quando roda:

- a tarefa vai para "em andamento" e o executor chama
  `claude -p --output-format stream-json --verbose` na pasta do projeto;
- o texto da tarefa e da spec ligada (critérios e texto) vai pela entrada padrão; o
  prompt mestre e o prompt do agente vão como instrução de sistema;
- só os MCPs escolhidos para o agente são carregados (`--strict-mcp-config`), com os
  segredos num arquivo temporário legível só pelo dono, apagado no fim;
- o processo recebe um ambiente mínimo: a credencial do Claude Code, o proxy da rede
  e uma pasta pessoal própria em `backend/data/homes/claude_code`, sem o token do
  harness nem outros segredos;
- cada leitura, edição, comando e mensagem vira evento no escritório e na conversa;
- no fim, a tarefa vai para "em revisão" com o resumo do agente na descrição, ou para
  "bloqueada" com o motivo (erro, saída sem resultado, tempo limite).

Mover a tarefa para outro status, excluí-la, desativar o agente ou trocar a ferramenta
dele interrompe a execução.

Sem ninguém para aprovar, o Claude Code recusa o que pediria permissão. O padrão
"Só editar arquivos" deixa editar e ler, mas recusa comandos como rodar testes;
"Liberar tudo" (`bypassPermissions`) roda qualquer comando e só deve ser usado num
servidor isolado.

Limites atuais:

- as perguntas que o agente faria não chegam à janela de Decisões: ele é instruído a
  escolher a opção mais segura e registrar a dúvida no resumo;
- os agentes trabalham direto na pasta do projeto, sem branch nem pull request; por
  isso o padrão é uma execução por vez;
- Cursor e Antigravity ainda não rodam.

## Próximos passos

Há dois jeitos de ligar cada ferramenta, e eles se complementam:

| Jeito | Como funciona | Ferramentas |
| --- | --- | --- |
| No servidor | O backend roda a ferramenta sem interface, com a credencial, o modelo, o prompt e os MCPs do agente, e traduz a saída em eventos | `claude -p --output-format stream-json`, `cursor-agent -p --output-format stream-json`, `agy -p` |
| Ponte do computador | A ferramenta roda no computador do usuário e os hooks dela mandam cada passo para `POST /api/events` (ou para um endpoint que traduz o formato dela) | Hooks HTTP do Claude Code, hooks do Antigravity |

1. Uma cópia do repositório por agente (git worktree) e entrega por branch, para
   rodar agentes em paralelo sem conflito.
2. Ponte de decisões: levar as perguntas e pedidos de permissão do Claude Code para a
   janela de Decisões.
3. Integração com Cursor (`cursor-agent -p`) e Antigravity (`agy -p`).
