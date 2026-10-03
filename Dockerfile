# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
COPY brand ./brand
COPY scripts ./scripts
COPY src ./src
COPY examples ./examples

RUN node --disable-warning=ExperimentalWarning scripts/build.mjs

FROM node:22-bookworm-slim AS runtime

# Host-side SQLite tasks require kernel resource limits before reading tenant data.
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux \
    && test -x /usr/bin/prlimit \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    CLANK_PLATFORM_DATA=/data

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/brand ./brand
COPY package.json LICENSE ./
COPY scripts/clank-platform.mjs scripts/platform-hosting.mjs scripts/platform-billing.mjs ./scripts/

EXPOSE 4200
STOPSIGNAL SIGTERM

CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/clank-platform.mjs"]
