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
FROM node:22-alpine AS api

RUN addgroup -S wyckoff && adduser -S wyckoff -G wyckoff

WORKDIR /app

COPY --from=api-builder /prod/ /app/

USER wyckoff
EXPOSE 8787

ENV NODE_ENV=production
CMD ["node", "dist/server.js"]

# ── Stage 4: Nginx + Frontend ──────────────────
FROM nginx:1.27-alpine AS web

COPY --from=deploy nginx.conf /etc/nginx/nginx.conf
COPY --from=web-builder /app/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
