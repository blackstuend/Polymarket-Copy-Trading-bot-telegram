# --- Stage 1: Build ---
FROM node:22-slim AS builder

# Use corepack to handle pnpm
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDeps for tsc)
RUN pnpm install --frozen-lockfile

# Copy source code and config
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript to JS
RUN pnpm run build

# --- Stage 2: Runtime ---
FROM node:22-slim AS production

WORKDIR /app

# Use corepack to handle pnpm
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

# Copy only package.json and the lockfile
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies
RUN pnpm install --prod --frozen-lockfile

# Copy the compiled JS from the builder stage
COPY --from=builder /app/dist ./dist

# Set environment
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/index.js"]
