# Single image: the API process also serves the built board, so prod is one
# container with no proxy, no CORS, and no split deploy to keep in sync.

# --- stage 1: build the board ---------------------------------------------
FROM oven/bun:1.2 AS frontend
WORKDIR /build
# Lockfile first so a source-only change reuses the install layer.
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
# tsc -b, not tsc --noEmit: tsconfig.json is solution-style and plain tsc
# silently checks nothing. Type errors must fail the image build.
RUN bunx tsc -b && bun run vite build

# --- stage 2: runtime ------------------------------------------------------
FROM python:3.13-slim AS runtime
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/usr/local \
    PYTHONUNBUFFERED=1

# Dependencies as their own layer, before app code.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY backend/ ./backend/
COPY baml_client/ ./baml_client/
COPY baml_src/ ./baml_src/
COPY --from=frontend /build/dist ./frontend/dist

# DuckDB and events.jsonl are written at runtime; the CSVs, ontology.yaml and
# demo_events.jsonl ship in the image via backend/data/.
RUN useradd --create-home --uid 10001 foundry && chown -R foundry:foundry /app
USER foundry

EXPOSE 8400
ENV FOUNDRY_STATIC_DIR=/app/frontend/dist

# Seeds the warehouse on boot because the container filesystem is ephemeral —
# without it a fresh container has an empty DuckDB and every query returns
# nothing. Cheap (~1s) and idempotent.
CMD ["sh", "-c", "python -m backend.app.seed && exec uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8400}"]
