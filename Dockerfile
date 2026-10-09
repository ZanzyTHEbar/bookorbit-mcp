FROM oven/bun:1.4.2

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY index.ts ./
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data

USER bun
ENV PORT=3000 HISTORY_PATH=/data/bookorbit-history.sqlite
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "run", "start"]
