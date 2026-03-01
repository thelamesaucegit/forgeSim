# ----------------- Stage 1: Build the lean Forge project -----------------

FROM maven:3.8-openjdk-17 AS javabuilder

# --- THE FIX IS HERE: Define a build-time argument for diagnostic level ---
# Default to 1 (production/quiet) if not provided.
ARG DIAG_LEVEL=1

WORKDIR /usr/src/app

# Clone your newly pruned repository
RUN git clone https://github.com/thelamesaucegit/forgeSim.git .

# --- THE FIX IS HERE: Conditionally run diagnostic commands ---
# These commands will only run if DIAG_LEVEL is set to 2 or 3 during the build.
RUN if [ "$DIAG_LEVEL" -gt 1 ]; then \
        echo "--- DIAGNOSTIC (Level > 1): Last commit in cloned repository ---"; \
        git log -1 --oneline; \
        echo "--- DIAGNOSTIC (Level > 1): Contents of Main.java ---"; \
        cat /usr/src/app/forge-gui-desktop/src/main/java/forge/view/Main.java; \
        echo "---------------------------------------------------"; \
    fi

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

# --- THE FIX IS HERE: Make the build-time ARG available at runtime ---
# This ensures server.ts can read the same DIAG_LEVEL.
ARG DIAG_LEVEL=1
ENV DIAG_LEVEL=${DIAG_LEVEL}

WORKDIR /app

RUN apt-get update && apt-get install -y openjdk-17-jre-headless unzip strace && rm -rf /var/lib/apt/lists/*

COPY --from=nodebuilder /app/package*.json ./
RUN npm install --omit=dev

COPY --from=nodebuilder /app/dist ./dist
COPY --from=javabuilder /usr/src/app/forge-gui-desktop/target/forge-gui-desktop-2.0.11-SNAPSHOT-jar-with-dependencies.jar ./forgeSim.jar
COPY --from=javabuilder /usr/src/app/forge-gui/res ./res

EXPOSE 8080
CMD ["node", "dist/server.js"]
