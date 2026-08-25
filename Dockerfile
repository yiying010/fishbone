# syntax=docker/dockerfile:1

# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY server ./server
RUN npm run build

# ---- production dependencies ----------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Not a mount point: the app is served at / inside the container and learns its
# public prefix from the browser at runtime. See docs/deployment.md.
ENV HOST=0.0.0.0 \
    PORT=3000

RUN apk add --no-cache tini

COPY --chown=node:node package.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

# Exercises the same endpoint an external monitor would, so a database outage
# marks the container unhealthy rather than merely logging.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM so long-poll connections close cleanly.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]
