# Mindora auth-service — Node.js 24 (see .nvmrc)
# Build from repo root: docker build -f apps/auth-service/Dockerfile .

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
RUN AUTH_DATABASE_URL=postgresql://mindora:mindora@localhost:5432/mindora_auth \
  npx prisma generate --schema=apps/auth-service/prisma/schema.prisma

RUN npx turbo run build --filter=@mindora/auth-service
# tsc only emits compiled .ts sources — copy the (now Alpine-native) Prisma
# client into dist alongside it.
RUN cp -r apps/auth-service/src/generated apps/auth-service/dist/generated

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/auth-service/dist ./apps/auth-service/dist
COPY --from=build /app/apps/auth-service/package.json ./apps/auth-service/package.json
COPY --from=build /app/packages ./packages

EXPOSE 3001
CMD ["node", "apps/auth-service/dist/index.js"]
