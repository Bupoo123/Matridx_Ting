FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --no-frozen-lockfile
COPY apps/worker apps/worker
COPY packages/shared packages/shared
RUN pnpm --filter @matridx/shared build && pnpm --filter @matridx/worker build
CMD ["pnpm", "--filter", "@matridx/worker", "start"]
