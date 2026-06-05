# ============================================
# Wyckoff Trading Agent — Dockerfile
# Build context: web/  (pnpm workspace root)
# Multi-stage: frontend + API → production
#
# Requires BuildKit (DOCKER_BUILDKIT=1) for cache mounts
# ============================================

# ── Stage 1: Build Frontend ───────────────────
FROM node:22-alpine AS web-builder

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# pnpm workspace root + deps (rarely changes → cached first)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/web/tsconfig.json apps/web/
COPY apps/web/vite.config.ts apps/web/
COPY apps/web/index.html apps/web/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# source (changes frequently → after deps install)
COPY packages/shared/src/ packages/shared/src/
COPY apps/web/src/ apps/web/src/

# market data files (for vite marketDataPlugin writeBundle)
COPY --from=data . /data/

RUN pnpm --filter @wyckoff/web build

# ── Stage 2: Build API ────────────────────────
FROM node:22-alpine AS api-builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/build-server.mjs apps/api/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps/api/src/ apps/api/src/

RUN pnpm --filter @wyckoff/api build

# Create standalone production deployment
RUN pnpm --filter @wyckoff/api deploy --prod --legacy /prod

# ── Stage 3: API Runtime ──────────────────────
FROM node:22-slim AS api

RUN rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/* \
    && sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip wget \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && addgroup --system wyckoff && adduser --system --no-create-home --group wyckoff

WORKDIR /app

COPY --from=api-builder /prod/ /app/

# Python deps (cached mount — survives pip install across rebuilds)
COPY --from=root requirements.txt /app/

RUN --mount=type=cache,id=pip,target=/root/.cache/pip \
    pip3 install --no-cache-dir --break-system-packages \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    --default-timeout=120 \
    -r requirements.txt

# Python source (changes frequently → after pip install)
COPY --from=root tools/ /app/tools/
COPY --from=root integrations/ /app/integrations/
COPY --from=root core/ /app/core/
COPY --from=root utils/ /app/utils/

USER wyckoff
EXPOSE 8787

ENV NODE_ENV=production \
    PYTHONPATH=/app
CMD ["node", "dist/server.js"]

# ── Stage 4: Python Agent Runtime ──────────────
FROM python:3.11-slim AS python-base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Replace apt mirrors for faster CI (deb.debian.org often times out)
RUN rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/* \
    && sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Python deps (cached mount — survives pip install across rebuilds)
COPY --from=root pyproject.toml requirements.txt ./

RUN --mount=type=cache,id=pip,target=/root/.cache/pip \
    pip install --no-cache-dir \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    -r requirements.txt

# Install the wyckoff package itself
COPY --from=root cli/ cli/
COPY --from=root agents/ agents/
COPY --from=root core/ core/
COPY --from=root integrations/ integrations/
COPY --from=root tools/ tools/
COPY --from=root utils/ utils/
COPY --from=root scripts/ scripts/
COPY --from=root data/ data/
COPY --from=root mcp_server.py AGENTS.md ./

RUN --mount=type=cache,id=pip,target=/root/.cache/pip \
    pip install --no-cache-dir \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    . --no-deps

FROM python-base AS agent

RUN addgroup --system wyckoff && adduser --system --group wyckoff

# gosu for dropping from root → wyckoff at runtime
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure volume mount points and home are writable by the wyckoff user
RUN mkdir -p /app/data /app/logs /home/wyckoff && chown -R wyckoff:wyckoff /app/data /app/logs /home/wyckoff

COPY --from=deploy entrypoint-agent.sh /entrypoint.sh

# Start as root so entrypoint can chown volume mounts, then drop to wyckoff
ENTRYPOINT ["/entrypoint.sh"]

ENV HOME=/home/wyckoff
WORKDIR /app

# Default: run scheduler loop (configurable via CMD override)
CMD ["python", "-m", "cli", "dash", "--port", "8080"]


# ── Stage 5: Nginx + Frontend ──────────────────
FROM nginx:1.27-alpine AS web

COPY --from=deploy nginx.conf /etc/nginx/nginx.conf
COPY --from=web-builder /app/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
