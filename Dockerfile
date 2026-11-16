# Imagem única: frontend compilado + backend Python + Claude Code.
# Uso no EasyPanel: app do tipo "Dockerfile" apontando para este repositório.

FROM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
COPY shared/ /src/shared/
RUN npm run build

FROM node:22-bookworm-slim AS node

FROM python:3.12-slim-bookworm
ARG CLAUDE_CODE_VERSION=2.1.325
# Node vem da imagem oficial (o Claude Code é um pacote npm); git para os agentes.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node \
 && apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

WORKDIR /app
COPY backend/pyproject.toml backend/
COPY backend/pixel_office/ backend/pixel_office/
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -e ./backend
COPY --from=frontend /src/frontend/dist/ frontend/dist/
COPY docker-entrypoint.sh /usr/local/bin/

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PIXEL_OFFICE_HOST=0.0.0.0 \
    PIXEL_OFFICE_PORT=8000 \
    PIXEL_OFFICE_DB=/data/pixel-office.db

# /data: banco, chave dos segredos e HOME do Claude Code. /workspace: repositório do produto.
RUN mkdir -p /data /workspace && chown node:node /data /workspace
VOLUME ["/data", "/workspace"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PIXEL_OFFICE_PORT','8000'),timeout=4)"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "pixel_office"]
