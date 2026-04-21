# syntax=docker/dockerfile:1
# Production bundle: static frontend + Express API on one port (4001).
# Frontend is built on Alpine (static output only); API runs on bookworm-slim for native addons.

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
RUN apk add --no-cache libc6-compat
COPY frontend/package*.json ./
RUN npm ci && npm cache clean --force
COPY frontend/ ./
RUN npm run build:local && npm cache clean --force

FROM node:22-bookworm-slim AS backend-build
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci && npm cache clean --force
COPY backend/ ./
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS api
WORKDIR /app

COPY --from=backend-build /app/package.json ./
COPY --from=backend-build /app/package-lock.json ./
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV PORT=4001
ENV FRONTEND_DIST=/app/frontend/dist
ENV PREDICT_URL=http://predict:8001

EXPOSE 4001

CMD ["node", "dist/index.js"]
