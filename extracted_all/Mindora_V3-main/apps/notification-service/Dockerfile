# Mindora notification-service — Node.js 24 (see .nvmrc)
# Build from repo root: docker build -f apps/notification-service/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
# The Prisma client committed under src/generated is a dev machine's own
# build (native query engine binary for that machine's OS), not portable —
# regenerate it here so the engine binary matches this Alpine/musl image.
# The env value just needs to be a non-empty string; generate never connects.
RUN NOTIFICATION_DATABASE_URL=postgresql://mindora:mindora@localhost:5432/mindora_notifications \
  npx prisma generate --schema=apps/notification-service/prisma/schema.prisma

RUN npx turbo run build --filter=@mindora/notification-service
# tsc only emits compiled .ts sources — copy the (now Alpine-native) Prisma
# client into dist alongside it.
RUN cp -r apps/notification-service/src/generated apps/notification-service/dist/generated

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/notification-service/dist ./apps/notification-service/dist
COPY --from=build /app/apps/notification-service/package.json ./apps/notification-service/package.json
COPY --from=build /app/packages ./packages

EXPOSE 3008
CMD ["node", "apps/notification-service/dist/index.js"]
