# ----------------- Stage 1: Build the lean Forge project -----------------

FROM maven:3.8-openjdk-17 AS javabuilder

WORKDIR /usr/src/app

# Clone your repository
RUN git clone https://github.com/thelamesaucegit/forgeSim.git .

# A simple, standard Maven build.
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

# ----------------- Stage 3: Assemble the final runtime image -----------------

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y openjdk-17-jre-headless unzip strace && rm -rf /var/lib/apt/lists/*

COPY --from=nodebuilder /app/package*.json ./
RUN npm install --omit=dev

COPY --from=nodebuilder /app/dist ./dist

# --- THE FIX IS HERE: The typo "jabuilder" has been corrected to "javabuilder" ---
COPY --from=javabuilder /usr/src/app/forge-gui-desktop/target/forge-gui-desktop-2.0.11-SNAPSHOT-jar-with-dependencies.jar ./forgeSim.jar
COPY --from=javabuilder /usr/src/app/forge-gui/res ./res

EXPOSE 8080
CMD ["node", "dist/server.js"]
