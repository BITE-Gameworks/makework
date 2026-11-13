# mwt-node: the built node (`npm run build:node`, as deployed per docs/nodes.md) and the stress-test bot (bot/), both
# from the same source snapshot as the clients' mwt-app image. Built by up.sh after mwt-app, repository root as
# context: podman build -f mesh-test/node.Containerfile --ignorefile mesh-test/containerignore .
FROM localhost/mwt-app:latest AS build
COPY mesh-test/bot/ /app/mwt-bot/
RUN npm run build:node \
 && node node_modules/vite/bin/vite.js build --config mwt-bot/vite.config.mts

# NODE.md's minimum Node version. werift, maxmind and mediasoup are installed here: the test LANs have no internet.
# mediasoup's worker is the one mwt-app built for bookworm (the prebuilt download needs a newer glibc, and slim has
# no compiler); MEDIASOUP_WORKER_BIN makes the postinstall skip it and the node run it. The build then starts one
# worker, so an image whose calls through nodes can't work never reaches a test.
FROM docker.io/library/node:22-bookworm-slim
WORKDIR /node
COPY --from=build /app/dist-node/ ./
COPY --from=build /app/node_modules/mediasoup/worker/out/Release/mediasoup-worker /node/mediasoup-worker
ENV MEDIASOUP_WORKER_BIN=/node/mediasoup-worker
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force \
 && node --input-type=module -e "const m = await import('mediasoup'); const w = await m.createWorker(); console.log('mediasoup worker', m.version, 'pid', w.pid); w.close();"
COPY mesh-test/bot/bots.mjs /node/bots.mjs
COPY --chmod=755 mesh-test/node-entrypoint.sh /usr/local/bin/mwt-node-entrypoint
ARG GIT_SHA=unknown
ENV MWT_GIT_SHA=$GIT_SHA
ENTRYPOINT ["/usr/local/bin/mwt-node-entrypoint"]
CMD ["node"]
