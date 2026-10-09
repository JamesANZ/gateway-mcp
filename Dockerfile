# @title Gateway image
# @notice Builds the TypeScript, then keeps only the JavaScript and production
#         dependencies. The compiler does not ship in the image you run.
# @dev Node 22.17 matches the medical-mcp image so both containers on one
#      machine share a base layer. The process listens on 8080, not 3000,
#      so it can sit beside medical-mcp without a port clash inside a Pod
#      network. Medical stays on 3000. Only this container is published
#      onto the host, and only by Compose or a port-forward, not by this file.
#      Compose publishes host port 8090. See docker-compose.yml.

FROM node:22.17-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.17-bookworm-slim AS runtime

WORKDIR /app

# @notice HOST 0.0.0.0 is required inside a container. 127.0.0.1 would
#         listen on a loopback the Service cannot connect to.
# @dev GATEWAY_CONFIG points at the file baked into the image. Compose and
#      Kubernetes mount the same file over a path and may change this env.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    GATEWAY_CONFIG=/app/config/gateway.yaml

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY config ./config

# @notice The official image has a non-root user named node (uid 1000).
USER node

EXPOSE 8080

CMD ["node", "build/index.js"]
