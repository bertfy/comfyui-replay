#!/usr/bin/env bash
# Start ComfyUI in background → wait for ready → exec studio.js in foreground.
# When studio.js exits (signal/crash), tini reaps ComfyUI via the SIGTERM trap.
set -euo pipefail

COMFY_PORT="${COMFYUI_PORT:-8188}"

# ── Start ComfyUI ─────────────────────────────────────────────────────────────
echo "▶  Starting ComfyUI on 127.0.0.1:${COMFY_PORT} (CPU-only)..."
cd /opt/ComfyUI
.venv/bin/python main.py \
  --listen 127.0.0.1 --port "${COMFY_PORT}" \
  --cpu --disable-auto-launch \
  > /tmp/comfyui.log 2>&1 &
COMFY_PID=$!

# Forward signals so SIGTERM cleanly shuts ComfyUI too
trap "echo '⏹  Stopping ComfyUI'; kill -TERM $COMFY_PID 2>/dev/null; wait $COMFY_PID 2>/dev/null" EXIT INT TERM

# ── Wait for readiness ────────────────────────────────────────────────────────
echo "⏳  Waiting for ComfyUI HTTP to respond..."
for i in $(seq 1 180); do
  if curl -sf -o /dev/null "http://127.0.0.1:${COMFY_PORT}/"; then
    echo "✅  ComfyUI ready after ${i}s"
    break
  fi
  if ! kill -0 "$COMFY_PID" 2>/dev/null; then
    echo "❌  ComfyUI died during startup. Last log:"
    tail -50 /tmp/comfyui.log
    exit 1
  fi
  sleep 1
done

if ! curl -sf -o /dev/null "http://127.0.0.1:${COMFY_PORT}/"; then
  echo "❌  ComfyUI failed to come up in 180s"
  tail -50 /tmp/comfyui.log
  exit 1
fi

# ── Hand off to studio.js ─────────────────────────────────────────────────────
cd /app
echo "▶  Starting studio.js (WS on :${WS_PORT:-3002})"
exec node studio.js
