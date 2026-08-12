# syntax=docker/dockerfile:1

# ---------- Abhaengigkeiten ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
# npm ci installiert exakt die Versionen aus dem Lockfile — reproduzierbar und
# ohne stille Aktualisierungen beim Bauen.
#
# Bei npm-Workspaces landen die Abhaengigkeiten gehoistet in /app/node_modules;
# ein web/node_modules entsteht nur, wenn eine Version dort kollidiert. Das
# mkdir stellt sicher, dass der naechste Build-Schritt in beiden Faellen etwas
# zu kopieren findet.
RUN npm ci && mkdir -p /app/web/node_modules

# ---------- Bauen ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
RUN npm run build

# ---------- Laufzeit ----------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Nur Produktionsabhaengigkeiten uebernehmen: Build-Werkzeuge gehoeren nicht in
# ein Laufzeit-Image, sie vergroessern es und erweitern die Angriffsflaeche.
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY drizzle ./drizzle

# Nicht als root laufen. Das Node-Image bringt den Benutzer "node" bereits mit.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
