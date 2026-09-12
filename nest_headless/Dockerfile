ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm
FROM $BUILD_FROM

# Debian base (swapped from Alpine 2026-08-30): glibc lets native
# onnxruntime-node load, so the local vision models (cat detector + door
# classifier) run in-process, multithreaded, instead of WASM in the page.
# Chromium from Debian repos includes H.264 decode.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium nodejs npm jq fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/package.json /app/
RUN npm install --omit=dev && npm cache clean --force

COPY app/ /app/
COPY run.sh /
RUN chmod +x /run.sh

ENV CHROMIUM_PATH=/usr/bin/chromium
CMD ["/run.sh"]
