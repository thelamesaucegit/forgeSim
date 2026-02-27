# ----------------- Stage 1: Build the full Forge project with Maven -----------------
# We use an official Maven image which includes the JDK and Git.
FROM maven:3.8-openjdk-17 AS javabuilder
WORKDIR /usr/src/app

# --- THIS IS THE MAJOR CHANGE ---
# Instead of copying local files, we clone the repository directly.
# The --recursive flag is CRITICAL as it automatically initializes and clones all submodules.
RUN git clone --recursive https://github.com/thelamesaucegit/forgeSim .

# Now that all source code (including submodules) is present, run the Maven package command.
RUN mvn package -DskipTests

# --- DEBUGGING STEP ---
# List the contents of the target directories to verify the JAR and res folder exist.
# This helps confirm our paths are correct before we try to copy from them.
RUN echo "--- Verifying Java Build Artifacts ---"
RUN ls -la /usr/src/app/forge-gui-desktop/target/
RUN ls -la /usr/src/app/forge-gui/

# ----------------- Stage 2: Build the TypeScript server code -----------------
# This stage does not change. It still builds your Node.js code from your local files.
FROM node:20-bookworm-slim AS nodebuilder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json .
COPY server.ts .
COPY parser.ts .
RUN npm run build

# ----------------- Stage 3: Assemble the final, lean runtime image -----------------
# This stage does not change. It assembles the artifacts from the previous stages.
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y openjdk-17-jre-headless && rm -rf /var/lib/apt/lists/*

COPY --from=nodebuilder /app/package*.json ./
RUN npm install --omit=dev
COPY --from=nodebuilder /app/dist ./dist

# Copy the JAR from the javabuilder stage
COPY --from=javabuilder /usr/src/app/forge-gui-desktop/target/forge-gui-desktop-2.0.11-SNAPSHOT-jar-with-dependencies.jar ./forgeSim.jar

# Copy the resource folder from the javabuilder stage
COPY --from=javabuilder /usr/src/app/forge-gui/res ./res

EXPOSE 8080

CMD ["node", "dist/server.js"]
