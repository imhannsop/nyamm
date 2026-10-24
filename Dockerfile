# Use Bun's official image as base
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies into a temp directory
# This will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Copy node_modules from temp directory
# Then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# Copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /app/index.ts .
# index.ts imports ./src/app, which imports the whole src/ tree. Without this the
# container starts and dies immediately on `Cannot find module './src/app'`.
COPY --from=prerelease /app/src ./src
COPY --from=prerelease /app/package.json .

# Expose the port the app runs on
EXPOSE 5000

# Set environment to production
ENV NODE_ENV=production

# Run the app
# index.ts is the only server bootstrap here and it sets `idleTimeout: 0`; Bun's
# 10s default otherwise cuts stream-proxy responses mid-transfer. Don't replace it
# with a bare hono/node-server start without carrying that setting over.
USER bun
CMD ["bun", "run", "index.ts"]
