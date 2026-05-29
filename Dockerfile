# ---- Gasp Machine: site + YouTube-playlist proxy ----
FROM node:20-alpine

# App listens on this port inside the container (server.js reads PORT).
ENV NODE_ENV=production \
    PORT=8002

WORKDIR /app

# Install only production deps, using the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (server + client).
COPY src ./src

EXPOSE 8002

CMD ["node", "src/server/server.js"]
