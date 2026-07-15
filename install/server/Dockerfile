# Hearth server — container image for cloud or any Docker host.
# Build:  docker build -t hearth-server .
# Run:    docker run -d --name hearth --network host \
#           -e HEARTH_ANNOUNCED_IP=YOUR.PUBLIC.IP \
#           -v hearth-data:/data hearth-server
#
# Host networking is strongly recommended: mediasoup's media port and ICE
# need the real host IP. See the deployment guide for cloud specifics.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 build-essential ffmpeg yt-dlp ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY . .
ENV HEARTH_DATA_DIR=/data
VOLUME /data
EXPOSE 4443/tcp 44444/udp 44444/tcp
CMD ["node", "src/index.js"]
