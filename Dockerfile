# syntax=docker/dockerfile:1
# Production bundle: static frontend + Express API on one port (4001).

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build:local

FROM node:22-bookworm-slim AS api
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build && npm prune --omit=dev
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV PORT=4001
ENV FRONTEND_DIST=/app/frontend/dist
ENV PREDICT_URL=http://predict:8001

EXPOSE 4001

CMD ["node", "dist/index.js"]
