# One image: the engine, the server, and the built client it serves.
#
# The client is served by the server itself, on one origin -- which is what
# lets the client ask for `/api` and `/ws` relatively and work out `wss:` from
# the page's own protocol, with nothing to configure per environment.

FROM node:22-slim AS build
WORKDIR /app

# Manifests first, so a change to source does not reinstall the world.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci

COPY . .
RUN npm run build

# Drop the build-only dependencies from what gets copied forward.
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./packages/core/
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/client/dist ./packages/client/dist

# Answer the container's own network, not just itself, and serve the client
# from this same process.
ENV HOST=0.0.0.0
ENV CLIENT_DIR=packages/client/dist
# Behind a platform's proxy, so `X-Forwarded-For` is the platform's word for
# who is calling and can be believed. Unset this if you expose the port
# directly -- otherwise a caller can name any address it likes and the
# rate limit counts a fiction.
ENV TRUST_PROXY=true
EXPOSE 8787

# Run as somebody who cannot write to the application. Nothing here needs to.
USER node

CMD ["node", "packages/server/dist/index.js"]
