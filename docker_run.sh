#!/usr/bin/env bash
# Build and run the Gasp Machine service in Docker on port 8002.
# Secrets (YOUTUBE_API_KEY, PLAYLIST_ID, ...) are read from .env at runtime.
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="gasp-machine"
CONTAINER="gasp-machine"
PORT=8002

# .env holds the API key + playlist ID. Warn (don't fail) if it's missing —
# the app falls back to its static list without a key.
ENV_ARGS=()
if [[ -f .env ]]; then
  ENV_ARGS+=(--env-file .env)
else
  echo "⚠  .env not found — running without API key (fallback list only)."
fi

echo "==> Removing any existing container '$CONTAINER'…"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "==> Removing any existing image '$IMAGE'…"
docker rmi -f "$IMAGE" >/dev/null 2>&1 || true

echo "==> Building image '$IMAGE'…"
docker build -t "$IMAGE" .

echo "==> Starting '$CONTAINER' on http://localhost:$PORT …"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$PORT:8002" \
  "${ENV_ARGS[@]}" \
  -e PORT=8002 \
  "$IMAGE"

echo "==> Up. Logs: docker logs -f $CONTAINER"
