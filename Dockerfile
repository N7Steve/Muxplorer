# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
RUN npm install -g pnpm@11.25.0
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN pnpm build
RUN pnpm --filter @muxplorer/api --prod deploy --legacy /production

FROM debian:bookworm-slim AS tools
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config curl ca-certificates xz-utils libssl-dev libexpat1-dev libavcodec-dev zlib1g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ARG TARGETARCH
ARG SEVENZIP_VERSION=26.05
ARG SEVENZIP_SHA256=22cf82fcc6eb7474f1d5bb4f02c0f8ebd573a718089d6833dc30f8350a3b232e
RUN test "$TARGETARCH" = amd64 && curl -fL "https://github.com/ip7z/7zip/releases/download/${SEVENZIP_VERSION}/7z${SEVENZIP_VERSION%%.*}${SEVENZIP_VERSION##*.}-linux-x64.tar.xz" -o 7zip.tar.xz && echo "$SEVENZIP_SHA256  7zip.tar.xz" | sha256sum -c - && mkdir sevenzip && tar -xJf 7zip.tar.xz -C sevenzip
ARG MAKEMKV_VERSION=2.0.0
ARG MAKEMKV_OSS_SHA256=435316b2d219eb48c880526557addd076b5f5e6de5171424c7651f9cac95b161
ARG MAKEMKV_BIN_SHA256=f1265e74875a186efdfbbbec7459a64e969033515e53cbc4d805f0a374f0a124
RUN curl -fL "https://www.makemkv.com/download/makemkv-oss-${MAKEMKV_VERSION}.tar.gz" -o oss.tar.gz && echo "$MAKEMKV_OSS_SHA256  oss.tar.gz" | sha256sum -c - && curl -fL "https://www.makemkv.com/download/makemkv-bin-${MAKEMKV_VERSION}.tar.gz" -o bin.tar.gz && echo "$MAKEMKV_BIN_SHA256  bin.tar.gz" | sha256sum -c - && tar -xzf oss.tar.gz && tar -xzf bin.tar.gz
RUN cd makemkv-oss-${MAKEMKV_VERSION} && ./configure --disable-gui --prefix=/usr && make -j2 && make install DESTDIR=/install
# Repackage the unchanged Linux binary + data + EULA under the explicit Linux-package exception.
# No EULA acceptance is manufactured during the build; execution is gated by the application.
RUN mkdir -p /install/usr/bin /install/usr/share/MakeMKV /licenses && cp makemkv-bin-${MAKEMKV_VERSION}/bin/amd64/makemkvcon /install/usr/bin/ && cp makemkv-bin-${MAKEMKV_VERSION}/src/share/* /install/usr/share/MakeMKV/ && cp makemkv-bin-${MAKEMKV_VERSION}/src/eula_en_linux.txt /licenses/makemkv.txt && cp makemkv-oss-${MAKEMKV_VERSION}/License.txt /licenses/makemkv-oss.txt && cp makemkv-oss-${MAKEMKV_VERSION}/mmccextr/License.txt /licenses/mmccextr.txt && cp sevenzip/License.txt /licenses/7zip.txt
COPY docker/rename.c docker/sandbox.c ./
RUN cc -O2 -Wall -Wextra -Werror rename.c -o /install/usr/bin/mux-rename && cc -O2 -Wall -Wextra -Werror sandbox.c -o /install/usr/bin/mux-sandbox

FROM node:24-bookworm-slim AS production
RUN apt-get update && apt-get install -y --no-install-recommends mkvtoolnix ca-certificates libavcodec59 libexpat1 libssl3 zlib1g tini && rm -rf /var/lib/apt/lists/*
COPY --from=tools /install/ /
COPY --from=tools /build/sevenzip/7zz /usr/local/bin/7zz
COPY --from=tools /licenses/ /app/licenses/
RUN ldconfig && mkdir -p /config/makemkv/.MakeMKV /data/downloads /data/plex && chown -R 1000:1000 /config
WORKDIR /app
COPY --from=build /production/ ./api/
COPY --from=build /src/apps/web/dist/browser/ ./web/
ENV NODE_ENV=production PORT=8098 CONFIG_DIR=/config DOWNLOADS_ROOT=/data/downloads PLEX_ROOT=/data/plex WEB_DIR=/app/web MAKEMKV_HOME=/config/makemkv TZ=Europe/Madrid LANG=C.UTF-8 LC_ALL=C.UTF-8
USER 1000:1000
EXPOSE 8098
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "api/dist/main.js"]
