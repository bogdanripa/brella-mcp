# Build stage: compile TypeScript
FROM node:22-slim AS build
WORKDIR /srv
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    PORT=80 \
    GIT_SHA=${GIT_SHA}
COPY --from=build /srv/node_modules ./node_modules
COPY --from=build /srv/dist ./dist
COPY package.json ./
EXPOSE 80
# server.ts listens on process.env.HOST || '::' (dual-stack in Node).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  --start-interval=250ms \
  CMD curl -fsS http://localhost:80/health || exit 1
CMD ["node", "dist/server.js"]
