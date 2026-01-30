# 使用 Node.js 20 Alpine 作為基礎映像
FROM node:20-alpine AS builder

# 啟用 pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# 複製 package.json 和 pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# 安裝所有依賴 (包含 devDependencies 以便編譯)
RUN pnpm install --frozen-lockfile

# 複製原始碼
COPY . .

# 編譯 TypeScript 代碼
RUN pnpm build

# --- 生產環境映像 ---
FROM node:20-alpine

# 啟用 pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# 複製 package.json 和 pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# 只安裝生產環境依賴
RUN pnpm install --prod --frozen-lockfile

# 從 builder 階段複製編譯後的程式碼
COPY --from=builder /app/dist ./dist

# 設定環境變數預設值 (建議透過 docker-compose 或 .env 覆寫)
ENV NODE_ENV=production

# 啟動應用程式
CMD ["node", "dist/index.js"]
