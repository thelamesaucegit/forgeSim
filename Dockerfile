# ----------------- Stage 1: Build the TypeScript code -----------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install

# Explicitly copy only the necessary source and config files
COPY tsconfig.json .
COPY server.ts .
COPY parser.ts .

# --- ADD THIS DEBUGGING STEP ---
RUN ls -la


RUN npm run build

# ----------------- Stage 2: Create the final runtime image -----------------
FROM node:20-bookworm-slim
WORKDIR /app

# Copy production dependencies from the builder
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev

# Copy the COMPILED JavaScript from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the Forge assets
COPY forgeSim.jar ./
COPY res/ ./res/

EXPOSE 8080

# Run the compiled JavaScript file directly with node
CMD ["node", "dist/server.js"]