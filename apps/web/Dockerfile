FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --no-frozen-lockfile
COPY apps/web apps/web
RUN pnpm --filter @matridx/web build
CMD ["pnpm", "--filter", "@matridx/web", "start"]
