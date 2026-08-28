# As a Home Assistant add-on the Supervisor passes BUILD_FROM from build.yaml
# (HA base images). Built standalone (`docker build`), it defaults to plain
# Alpine so the same Dockerfile serves Container/Core installs — see
# docker-compose.yml at the repository root.
ARG BUILD_FROM=alpine:3.21
FROM $BUILD_FROM

# Chromium from Alpine repos: built with system ffmpeg, includes H.264 decode.
RUN apk add --no-cache chromium nodejs npm jq font-noto ttf-freefont ca-certificates tzdata

WORKDIR /app
COPY app/package.json /app/
RUN npm install --omit=dev && npm cache clean --force

COPY app/ /app/
COPY run.sh /
RUN chmod +x /run.sh

ENV CHROMIUM_PATH=/usr/bin/chromium-browser
CMD ["/run.sh"]
