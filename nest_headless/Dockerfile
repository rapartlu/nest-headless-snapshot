ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.21
FROM $BUILD_FROM

# Chromium from Alpine repos: built with system ffmpeg, includes H.264 decode.
RUN apk add --no-cache chromium nodejs npm jq font-noto ttf-freefont

WORKDIR /app
COPY app/package.json /app/
RUN npm install --omit=dev && npm cache clean --force

COPY app/ /app/
COPY run.sh /
RUN chmod +x /run.sh

ENV CHROMIUM_PATH=/usr/bin/chromium-browser
CMD ["/run.sh"]
