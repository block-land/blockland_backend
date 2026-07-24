FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies before copying the source so Docker can reuse this layer
# when only application code changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://localhost:${PORT}/health" || exit 1

# Schema setup is run by the dedicated `migrate` Compose service. Keeping the
# application command focused on serving avoids every replica racing migrations.
CMD ["bun", "run", "start"]
