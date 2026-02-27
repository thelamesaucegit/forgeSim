# ----------------- Stage 1: Build the full Forge project with Maven -----------------
# We use an official Maven image which includes the JDK, perfect for compiling Forge.
FROM maven:3.8-openjdk-17 AS javabuilder
WORKDIR /usr/src/app

# Copy the entire project context into the builder stage.
# The .dockerignore file will prevent node_modules, etc., from being copied.
COPY . .

# Run the Maven package command. This will compile all modules (forge-core, forge-game, etc.)
# and create the target JAR file in its specific subdirectory.
RUN mvn package -DskipTests

# ----------------- Stage 2: Build the TypeScript server code -----------------
FROM node:20-bookworm-slim AS nodebuilder
WORKDIR /app
COPY package*.json ./
RUN npm install

COPY tsconfig.json .
COPY server.ts .
COPY parser.ts .

RUN npm run build

# ----------------- Stage 3: Assemble the final, lean runtime image -----------------
FROM node:20-bookworm-slim
WORKDIR /app

# We still need Java to run the JAR, but only the lightweight JRE.
RUN apt-get update && apt-get install -y openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*

# Copy production Node.js dependencies from the 'nodebuilder' stage
COPY --from=nodebuilder /app/package*.json ./
RUN npm install --omit=dev

# Copy the COMPILED JavaScript from the 'nodebuilder' stage
COPY --from=nodebuilder /app/dist ./dist

# --- The Key Changes Are Here ---

# 1. Copy the specific, fat JAR from the javabuilder and rename it to forgeSim.jar in our root.
COPY --from=javabuilder /usr/src/app/forge-gui-desktop/target/forge-gui-desktop-2.0.11-SNAPSHOT-jar-with-dependencies.jar ./forgeSim.jar

# 2. Copy the specific resource folder from the javabuilder's 'forge-gui' module to our root.
COPY --from=javabuilder /usr/src/app/forge-gui/res ./res

EXPOSE 8080

# Run the final compiled JavaScript file directly with node. This does not change.
CMD ["node", "dist/server.js"]
