# Copy-Polymarket Trading Bot

Polymarket 跟單交易機器人，支援 Mock（模擬）和 Live（實盤）交易模式，透過 Telegram 進行操作控制。

## Telegram Bot 指令

| 指令 | 參數 | 說明 |
|------|------|------|
| `/help` | - | 顯示指令說明 |
| `/start` | `<address> <url> <finance> <amount> <true/false>` | 創建實盤跟單任務 |
| `/mock` | `<address> <url> <finance> <amount> <true/false>` | 創建模擬跟單任務 |
| `/list` | - | 顯示所有實盤任務 |
| `/list_mock` | - | 顯示模擬任務詳細統計 |
| `/stop` | `<id>` | 停止任務（保留數據） |
| `/remove` | `<id>` 或 `all` | 刪除任務與相關數據 |
| `/ping` | - | 健康檢查 |

---

## Docker 部署

### 前置需求

- Docker
- Docker Compose

### 環境變數設定

複製 `.env.example` 並建立 `.env` 文件：

```bash
cp .env.example .env
```

編輯 `.env` 設定必要的環境變數：

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
RPC_URL=your_polygon_rpc_url
```

> 注意：`REDIS_HOST` 和 `MONGODB_URI` 會由 Docker Compose 自動設定，無需手動配置。

### 啟動服務

```bash
docker compose up -d
```

### 常用指令

```bash
# 查看服務狀態
docker compose ps

# 查看應用程式日誌
docker compose logs -f app

# 查看所有服務日誌
docker compose logs -f

# 停止服務
docker compose down

# 停止服務並刪除資料卷
docker compose down -v

# 重新構建並啟動（程式碼更新後）
docker compose up -d --build
```

### 服務說明

| 服務 | 說明 | 對外 Port |
|------|------|-----------|
| `app` | 應用程式主服務 | - |
| `redis` | Redis 快取與任務佇列 | 6379 |
| `mongo` | MongoDB 資料庫 | 27017 |

---
