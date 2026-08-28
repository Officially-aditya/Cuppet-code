FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
COPY packages/cli/package*.json ./packages/cli/
COPY packages/opencode-plugin/package*.json ./packages/opencode-plugin/
COPY packages/runtime-darwin-arm64/package*.json ./packages/runtime-darwin-arm64/
COPY packages/runtime-darwin-x64/package*.json ./packages/runtime-darwin-x64/
COPY packages/runtime-linux-arm64-gnu/package*.json ./packages/runtime-linux-arm64-gnu/
COPY packages/runtime-linux-x64-gnu/package*.json ./packages/runtime-linux-x64-gnu/

RUN npm ci --include=dev

COPY . .

RUN npm run build:ts

EXPOSE 8787

CMD ["node", "packages/cli/dist/cli.js", "relay", "--bind", "0.0.0.0"]
