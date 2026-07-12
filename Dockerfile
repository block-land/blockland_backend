FROM oven/bun:1-alpine

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Expose backend port
EXPOSE 3001

# Run database push and start backend
CMD ["sh", "-c", "bun run db:push && bun run start"]
