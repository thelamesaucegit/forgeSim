# ----------------- Stage 1: Build the full Forge project with Maven -----------------
FROM maven:3.8-openjdk-17 AS javabuilder
WORKDIR /usr/src/app
RUN git clone --recursive https://github.com/your-username/your-forge-repo.git .

# --- THIS IS THE CRITICAL CHANGE ---
# 1. -pl forge-gui-desktop : Tells Maven to build only the desktop GUI module and its dependencies.
# 2. -am : Also builds the required upstream dependencies of the specified module.
# 3. -Dlaunch4j.skip=true : This property specifically tells the launch4j plugin to do nothing.
RUN mvn package -pl forge-gui-desktop -am -DskipTests -Dlaunch4j.skip=true

# ----------------- Stage 2: Build the TypeScript server code -----------------
# This stage does not change.
FROM node:20-bookworm-slim AS nodebuilder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json .
COPY server.ts .
COPY parser.ts .
RUN npm run build

# ----------------- Stage 3: Assemble the final, lean runtime image -----------------
# This stage does not change.
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
