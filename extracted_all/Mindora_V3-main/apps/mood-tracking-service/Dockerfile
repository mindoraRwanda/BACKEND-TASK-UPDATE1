# Mindora mood-tracking-service — Node.js 24 (see .nvmrc)
# Build from repo root: docker build -f apps/mood-tracking-service/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY docs ./docs

RUN npm ci
# The Prisma client committed under src/generated is a dev machine's own
# build (native query engine binary for that machine's OS), not portable —
# regenerate it here so the engine binary matches this Alpine/musl image.
# The env value just needs to be a non-empty string; generate never connects.
RUN MOOD_DATABASE_URL=postgresql://mindora:mindora@localhost:5432/mindora_mood \
  npx prisma generate --schema=apps/mood-tracking-service/prisma/schema.prisma

RUN npx turbo run build --filter=@mindora/mood-tracking-service
# tsc only emits compiled .ts sources — copy the (now Alpine-native) Prisma
# client into dist alongside it.
RUN cp -r apps/mood-tracking-service/src/generated apps/mood-tracking-service/dist/generated

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/mood-tracking-service/dist ./apps/mood-tracking-service/dist
COPY --from=build /app/apps/mood-tracking-service/package.json ./apps/mood-tracking-service/package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/docs/mood-service.yaml ./docs/mood-service.yaml

EXPOSE 3004
CMD ["node", "apps/mood-tracking-service/dist/index.js"]
