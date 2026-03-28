# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build

RUN apk add --no-cache build-base python3

WORKDIR /app

# Install dependencies first (better layer caching)
# Copy lockfile too so npm ci can use exact resolved versions (faster + reproducible)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Copy source and build admin panel
COPY . .
RUN npm run build

# Copy JSON schema files into dist (tsc doesn't copy non-TS files)
RUN find src -name "*.json" | while read f; do \
      dest="dist/$f"; \
      mkdir -p "$(dirname "$dest")"; \
      cp "$f" "$dest"; \
    done

# Ensure public directory always exists (required by production stage COPY)
RUN mkdir -p /app/public/uploads

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN apk add --no-cache libssl3

WORKDIR /app

# Copy only what's needed to run
COPY --from=build /app/package.json ./
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/src ./src
COPY --from=build /app/config ./config

# Create uploads directory
RUN mkdir -p /app/public/uploads

# Strapi build outputs admin panel to /app/dist/build but the server
# looks for it inside @strapi/admin package — create a symlink to bridge them
RUN mkdir -p /app/node_modules/@strapi/admin/dist/server/server \
    && ln -sf /app/dist/build /app/node_modules/@strapi/admin/dist/server/server/build

# Non-root user for security
RUN addgroup -S strapi && adduser -S strapi -G strapi \
    && chown -R strapi:strapi /app
USER strapi

EXPOSE 1337

ENV NODE_ENV=production

CMD ["node", "node_modules/.bin/strapi", "start"]
