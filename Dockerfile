# Bun rather than the node image the MCP server uses: this service runs
# TypeScript directly (no build step), and Render's Node runtime has no Bun.
FROM oven/bun:1.3-alpine

WORKDIR /app

# Lockfile first so dependency installs cache across source-only changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# Render sets PORT; the app defaults to 4000 for local use.
EXPOSE 4000

# Runs as bun's non-root user, which the base image already provides.
USER bun

CMD ["bun", "src/index.ts"]
