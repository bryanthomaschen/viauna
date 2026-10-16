# Wren — one image: the Node server and the built web app.
#   docker build -t wren .
#   docker run -p 127.0.0.1:3000:3000 -v wren-data:/data -e IMAP_HOST=… -e SMTP_HOST=… wren
#
# Base pinned to an exact release; bump deliberately.
FROM node:24.22.0-alpine3.24 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG WREN_VERSION
RUN WREN_VERSION=${WREN_VERSION} npm run build

FROM node:24.22.0-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24.22.0-alpine3.24
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_ROOT=/app/dist/web
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY package.json LICENSE ./
# Runs unprivileged; /data holds the database, the message cache and uploads.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3000/api/config >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/index.js"]
