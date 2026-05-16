FROM node:22-bookworm-slim

# ── System deps: Python (for ComfyUI), ffmpeg (for mux), git (to clone Comfy),
#                 build-essential (some pip wheels), tini (proper signal handling)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      git ffmpeg ca-certificates curl tini \
      build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# ── ComfyUI install (CPU-only — we never queue jobs here; cursor-replay just
#                    drives the UI to build workflows. Real renders go to
#                    Comfy Cloud over HTTP.)
WORKDIR /opt
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /opt/ComfyUI
RUN python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir --upgrade pip \
    && .venv/bin/pip install --no-cache-dir \
         torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu \
    && .venv/bin/pip install --no-cache-dir -r requirements.txt

# ── Studio app
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Playwright chromium + matching system libs (xdotool, libnss3 etc.)
RUN npx playwright install --with-deps chromium

# Studio sources
COPY studio.js cursor-replay.js index.html ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Mount point for recordings (matches Fly.io volume mount in fly.toml)
RUN mkdir -p /data/recordings /data/studio_tmp \
    && ln -s /data/recordings ./recordings \
    && ln -s /data/studio_tmp ./studio_tmp

# Runtime config — overridable via Fly secrets / docker -e
ENV NODE_ENV=production \
    COMFYUI_URL=http://127.0.0.1:8188 \
    COMFYUI_PORT=8188 \
    WS_PORT=3002 \
    PLAYWRIGHT_HEADLESS=true

EXPOSE 3002

# tini reaps zombies from the ComfyUI subprocess
ENTRYPOINT ["/usr/bin/tini", "--", "./entrypoint.sh"]
