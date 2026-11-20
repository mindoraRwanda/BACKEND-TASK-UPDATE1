# Mindora messaging-service — Node.js 24 (see .nvmrc)
# Build from repo root: docker build -f apps/messaging-service/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
RUN npx turbo run build --filter=@mindora/messaging-service

FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/messaging-service/dist ./apps/messaging-service/dist
COPY --from=build /app/apps/messaging-service/package.json ./apps/messaging-service/package.json
COPY --from=build /app/packages ./packages

EXPOSE 3006
CMD ["node", "apps/messaging-service/dist/index.js"]
