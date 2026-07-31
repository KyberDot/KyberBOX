FROM node:20-bookworm-slim

# better-sqlite3 needs build tools to compile its native binding
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

# Persistent SQLite database lives here - mount a volume to this path
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "server.js"]
