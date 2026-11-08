FROM mcr.microsoft.com/playwright:v1.60.0-noble AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY tests ./tests
COPY .cursor/skills/verify-pirate-radio/verify.sh .cursor/skills/verify-pirate-radio/verify.sh
COPY scripts/dev/*.sh ./scripts/dev/
COPY scripts/dev/seed-assets/audio ./scripts/dev/seed-assets/audio
COPY scripts/parsers ./scripts/parsers
RUN npm test && npm run build

FROM mcr.microsoft.com/playwright:v1.60.0-noble

ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY README.md ./

EXPOSE 8123
CMD ["node", "dist/src/cli.js", "serve"]
