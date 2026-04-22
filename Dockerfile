# syntax=docker/dockerfile:1.7
# Production bundle: static frontend + Express API on one port (4001).
# Keep final image lean by separating build deps and production deps.

FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
RUN apk add --no-cache libc6-compat
COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build:local

FROM node:22-bookworm-slim AS backend-build
WORKDIR /app
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY backend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS backend-prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:22-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4001
ENV FRONTEND_DIST=/app/frontend/dist
ENV PREDICT_URL=http://predict:8001

COPY --from=backend-prod-deps /app/node_modules ./node_modules
COPY --from=backend-prod-deps /app/package.json ./package.json
COPY --from=backend-prod-deps /app/package-lock.json ./package-lock.json
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

EXPOSE 4001

CMD ["node", "dist/index.js"]
