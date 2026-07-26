# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
COPY scripts ./scripts
COPY src ./src
COPY examples ./examples

RUN node --disable-warning=ExperimentalWarning scripts/build.mjs

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    CLANK_PLATFORM_DATA=/data

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY scripts/clank-platform.mjs ./scripts/clank-platform.mjs

EXPOSE 4200
STOPSIGNAL SIGTERM

CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/clank-platform.mjs"]
