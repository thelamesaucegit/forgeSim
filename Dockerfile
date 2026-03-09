# ----------------- Stage 1: Build the lean Forge project -----------------
FROM maven:3.8-openjdk-17 AS javabuilder

WORKDIR /usr/src/app

# Copy the source code from the build context
COPY . .

# Run the Maven build
RUN mvn package -DskipTests --no-transfer-progress

# ----------------- Stage 2: Build the TypeScript server code -----------------
FROM node:22-bookworm-slim AS nodebuilder

WORKDIR /app

# Copy files necessary for the Node server build
COPY package*.json ./
RUN npm install

COPY tsconfig.json .
COPY server.ts .
COPY parser.ts .
# --- FIX: Add the new ReplayProcessor.ts file to the build context ---
COPY ReplayProcessor.ts .
COPY forge.profile.properties .

RUN npm run build

# ----------------- Stage 3: Assemble the final runtime image -----------------
FROM node:20-bookworm-slim

WORKDIR /app

# Install Java runtime
RUN apt-get update && apt-get install -y openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*

# Copy Node.js server dependencies
COPY --from=nodebuilder /app/package*.json ./
RUN npm install --omit=dev

# Copy the built Node.js server
COPY --from=nodebuilder /app/dist ./dist

# Copy the compiled Java application and resources
COPY --from=javabuilder /usr/src/app/forge-gui-desktop/target/forge-gui-desktop-2.0.11-SNAPSHOT-jar-with-dependencies.jar ./forgeSim.jar
COPY --from=javabuilder /usr/src/app/forge-gui/res ./res

# Create the decks directory
RUN mkdir -p /app/decks/constructed

EXPOSE 8080

CMD ["node", "dist/server.js"]
