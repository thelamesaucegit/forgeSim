# ----------------- Stage 1: Build the full Forge project with Maven -----------------
FROM maven:3.8-openjdk-17 AS javabuilder
WORKDIR /usr/src/app
COPY . .
RUN mvn package -DskipTests

# --- DEBUGGING STEP ---
# List the contents of the target directories to verify the JAR and res folder exist.
# This helps confirm our paths are correct before we try to copy from them.
RUN echo "--- Verifying Java Build Artifacts ---"
RUN ls -la /usr/src/app/forge-gui-desktop/target/
RUN ls -la /usr/src/app/forge-gui/

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

RUN apt-get update && apt-get install -y openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*

COPY --from=nodebuilder /app/package*.json ./
RUN npm install --omit=dev
COPY --from=nodebuilder /app/dist ./dist

# --- THE CRITICAL FIX IS IN THESE 'COPY --FROM' COMMANDS ---

# 1. Copy the JAR from the 'javabuilder' stage, not the local context.
COPY --from=javabuilder /usr/src/app/forge-gui-desktop/target/forge-gui-desktop-2.0.11-SNAPSHOT-jar-with-dependencies.jar ./forgeSim.jar

# 2. Copy the 'res' folder from the 'javabuilder' stage, not the local context.
COPY --from=javabuilder /usr/src/app/forge-gui/res ./res

EXPOSE 8080

CMD ["node", "dist/server.js"]
