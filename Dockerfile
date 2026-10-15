# Flix — self-hosted Netflix-style library server.
# Runtime deps: node (js), ffmpeg/ffprobe (media scan), chromium (1337x scraper via CDP).
FROM node:22-bookworm-slim

ENV TZ=Etc/UTC \
    CHROME_DATA_DIR=/tmp/flix-chrome \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ffmpeg \
        fonts-liberation \
        ca-certificates \
    && ln -sf /usr/bin/chromium /usr/local/bin/google-chrome \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /data /media "$CHROME_DATA_DIR" && chown -R node:node /app

USER node
EXPOSE 8787
CMD ["node", "server.js"]