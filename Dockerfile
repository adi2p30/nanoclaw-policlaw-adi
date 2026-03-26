# NanoClaw Host Process
# Runs the orchestrator (src/index.ts) that manages channels and spawns agent containers.
#
# IMPORTANT: working_dir must be overridden at runtime to match the host project path.
# Use docker-compose.yml — do not run this image directly.

# ---- Build stage ----
FROM node:22-slim AS builder

# Build tools required for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# ---- Runtime stage ----
FROM node:22-slim

# Install Docker CLI — required for spawning sibling agent containers via the Docker socket
RUN apt-get update \
    && apt-get install -y ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | tee /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY package.json ./

# Use absolute path so this works regardless of the runtime working_dir override
CMD ["node", "/app/dist/index.js"]
