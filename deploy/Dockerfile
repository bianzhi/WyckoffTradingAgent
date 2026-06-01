# ============================================
# Wyckoff Trading Agent — Dockerfile
# Build context: web/  (pnpm workspace root)
# Multi-stage: frontend + API → production
# ============================================

# ── Stage 1: Build Frontend ───────────────────
FROM node:22-alpine AS web-builder

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# pnpm workspace root + dependencies
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# shared package
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/

# web app
COPY apps/web/package.json apps/web/
COPY apps/web/tsconfig.json apps/web/
COPY apps/web/vite.config.ts apps/web/
COPY apps/web/index.html apps/web/

RUN pnpm install --frozen-lockfile

# source
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

RUN pnpm install --frozen-lockfile

COPY apps/api/src/ apps/api/src/

RUN pnpm --filter @wyckoff/api build

# Create standalone production deployment
RUN pnpm --filter @wyckoff/api deploy --prod --legacy /prod

# ── Stage 3: API Runtime ──────────────────────
FROM node:22-slim AS api

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN addgroup --system wyckoff && adduser --system --no-create-home --group wyckoff

WORKDIR /app

COPY --from=api-builder /prod/ /app/

# Python tools for spawnSync calls in data.ts
COPY --from=root requirements.txt /app/
COPY --from=root tools/ /app/tools/
COPY --from=root integrations/ /app/integrations/
COPY --from=root core/ /app/core/
COPY --from=root utils/ /app/utils/

RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

USER wyckoff
EXPOSE 8787

ENV NODE_ENV=production \
    PYTHONPATH=/app
CMD ["node", "dist/server.js"]

# ── Stage 4: Python Agent Builder ──────────────
# build context = web/ ; root context = project root (..)
FROM python:3.11-slim AS python-base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Use aliyun mirror for faster apt in CI (deb.debian.org often times out)
# Clean apt caches first — GitHub Actions runners often have low disk space
RUN rm -rf /var/cache/apt/archives/* /var/lib/apt/lists/* \
    && sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy Python project files (from project root via additional_contexts)
COPY --from=root pyproject.toml ./
COPY --from=root requirements.txt ./

# Install Python dependencies (aliyun mirror for faster pip in CI)
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.txt

# Install the wyckoff package itself (editable not needed in prod)
COPY --from=root cli/ cli/
COPY --from=root agents/ agents/
COPY --from=root core/ core/
COPY --from=root integrations/ integrations/
COPY --from=root tools/ tools/
COPY --from=root utils/ utils/
COPY --from=root scripts/ scripts/
COPY --from=root data/ data/
COPY --from=root mcp_server.py ./
COPY --from=root AGENTS.md ./

RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ -e . --no-deps

# ── Stage 5: Python Agent Runtime ──────────────
FROM python-base AS agent

RUN addgroup --system wyckoff && adduser --system --no-create-home --group wyckoff

USER wyckoff
WORKDIR /app

# Default: run scheduler loop (configurable via CMD override)
CMD ["python", "-m", "cli", "dash", "--port", "8080"]


# ── Stage 6: Nginx + Frontend ──────────────────
FROM nginx:1.27-alpine AS web

COPY --from=deploy nginx.conf /etc/nginx/nginx.conf
COPY --from=web-builder /app/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
