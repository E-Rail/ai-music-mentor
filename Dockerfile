# One image that serves the whole studio: the built page, the API behind it, and
# the listening models the microphone needs. Used by compose.yaml locally and by
# any host that can run a container.

# ---- Build the page ---------------------------------------------------------
FROM node:22-alpine AS web-build

# Pinned to the packageManager field in apps/web/package.json. pnpm refuses to
# run when the two disagree, so this version is load-bearing rather than taste.
RUN npm install --global pnpm@11.21.0

WORKDIR /src/apps/web

# The manifests and the patch they name have to arrive together: pnpm applies
# patchedDependencies during install and fails outright if the patch is missing,
# so copying package.json without patches/ breaks the build here.
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
COPY apps/web/patches/ ./patches/
RUN pnpm install --frozen-lockfile

COPY apps/web/ ./
# `prebuild` puts the listening models under public/, and Vite copies public/
# into dist/ — so the 60 MB checkpoint is baked into the image. A lesson happens
# wherever the student's piano is, and that is not always somewhere with wifi
# worth waiting on.
RUN pnpm build

# ---- Serve it ---------------------------------------------------------------
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_ENV=production \
    DATA_DIR=/data \
    HOME=/home/app

WORKDIR /app
COPY apps/api/requirements.txt /app/apps/api/requirements.txt
RUN pip install --no-cache-dir -r /app/apps/api/requirements.txt

COPY . /app
COPY --from=web-build /src/apps/web/dist /app/apps/web/dist
RUN chmod +x /app/scripts/container-entrypoint.sh

# Hosts that run containers unprivileged (Hugging Face Spaces among them) hand
# the process uid 1000 and nothing else. The database, the scores students
# upload and music21's own config file all need somewhere to write, so give that
# uid a home and hand it those paths now rather than failing on first use.
RUN useradd --create-home --uid 1000 app \
 && mkdir -p /data \
 && chown -R app:app /data /home/app
USER app

VOLUME ["/data"]
EXPOSE 8000
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
