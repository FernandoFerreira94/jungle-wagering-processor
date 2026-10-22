FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json bunfig.toml ./
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
CMD ["bun", "src/main.ts"]
