FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CODEX_HOME=/codex-home
ENV PATH=/app/node_modules/.bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash appuser
COPY package*.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY .env.example ./
RUN mkdir -p /app/data /codex-home /workspace-base /workspaces && chown -R appuser:appuser /app /codex-home /workspace-base /workspaces

USER appuser
VOLUME ["/app/data", "/codex-home", "/workspace-base", "/workspaces"]
CMD ["node", "--experimental-sqlite", "dist/index.js"]
