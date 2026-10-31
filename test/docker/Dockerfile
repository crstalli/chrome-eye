# Chrome Eye test container: Debian + real Chromium (headless + extension support).
# Debian is required (Ubuntu's chromium package is a snap stub and won't work in containers).
# Build: /mnt/f/ai/chrome-eye/bin/pdm build -f Dockerfile -t chrome-eye/chrome:local .
FROM docker.io/library/debian:stable-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        chromium-common \
        fonts-liberation \
        fonts-noto-cjk \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# Chrome runs as root in this disposable container; the harness passes --no-sandbox.
ENTRYPOINT ["/usr/bin/chromium"]
