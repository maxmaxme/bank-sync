FROM node:24-alpine

WORKDIR /app

# SQLite is node's built-in `node:sqlite`, so there are no native modules and
# nothing to compile for arm64.
COPY package.json package-lock.json ./
# --omit=optional: valibot's optional typescript peer would otherwise ship tsc in the image.
# --ignore-scripts: the only script is `prepare` (git hooks, dev-only); runtime deps are pure JS.
RUN npm ci --omit=dev --omit=optional --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    BANK_SYNC_DATA_DIR=/app/data \
    PORT=8080

# uid 1000, so the database in a bind-mounted data dir belongs to the host user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "src/index.ts"]
