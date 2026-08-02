FROM node:22-alpine AS web-build
RUN corepack enable
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web/ ./
RUN pnpm build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY apps/api/requirements.txt /app/apps/api/requirements.txt
RUN pip install --no-cache-dir -r /app/apps/api/requirements.txt
COPY . /app
COPY --from=web-build /src/apps/web/dist /app/apps/web/dist
RUN chmod +x /app/scripts/container-entrypoint.sh
VOLUME ["/data"]
EXPOSE 8000
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
