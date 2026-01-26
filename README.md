# Copy-Polymarket Trading Bot

Polymarket 跟單交易機器人，支援 Mock（模擬）和 Live（實盤）交易模式，透過 Telegram 進行操作控制。

## 目錄結構

```
copy-polymarket/
├── src/
│   ├── bot/
│   │   └── index.ts                 # Telegram Bot 指令與處理
│   ├── config/
│   │   ├── index.ts                 # 環境變數配置與驗證
│   │   └── copyStrategy.ts          # 下單策略配置
│   ├── models/
│   │   ├── UserActivity.ts          # 被跟單者活動記錄 (MongoDB)
│   │   ├── UserPosition.ts          # 用戶持倉模型 (舊版)
│   │   ├── MyPosition.ts            # Bot 模擬持倉追蹤
│   │   └── mockTradeRecrod.ts       # Mock 交易執行記錄
│   ├── services/
│   │   ├── mongodb.ts               # MongoDB 連線管理
│   │   ├── redis.ts                 # Redis 客戶端管理
│   │   ├── queue.ts                 # BullMQ 佇列與 Worker 設置
│   │   ├── taskService.ts           # Task CRUD 操作 (Redis)
│   │   ├── taskLock.ts              # 分散式任務鎖
│   │   ├── polymarket.ts            # Polymarket CLOB 客戶端
│   │   ├── tradeService.ts          # 核心交易邏輯
│   │   └── healthCheck.ts           # 啟動連線檢查
│   ├── types/
│   │   ├── task.ts                  # CopyTask 介面定義
│   │   └── position.ts              # PositionData 介面定義
│   ├── utils/
│   │   ├── fetchData.ts             # HTTP 請求與重試邏輯
│   │   ├── orderBook.ts             # 訂單簿工具函式
│   │   ├── redeem.ts                # 鏈上贖回邏輯
│   │   └── sleep.ts                 # Promise delay 工具
│   ├── workers/
│   │   └── task.worker.ts           # BullMQ 任務處理器
│   ├── scripts/
│   │   ├── analyzeTaskLoss.ts       # 任務損失分析
│   │   ├── clearTaskLocks.ts        # 清理鎖定工具
│   │   ├── printBids.ts             # 訂單簿檢視
│   │   ├── redeemCheck.ts           # 贖回檢查
│   │   └── showTasksAndPositions.ts # 狀態儀表板
│   └── index.ts                     # 主程式入口
├── dist/                            # 編譯後的 JavaScript
├── package.json                     # 依賴與腳本
├── tsconfig.json                    # TypeScript 配置
└── .env                             # 環境變數
```

---

## 核心依賴

| 套件 | 用途 |
|------|------|
| **@polymarket/clob-client** | Polymarket CLOB（中央限價訂單簿）唯讀客戶端 |
| **bullmq** (v5.66.5) | 分散式任務佇列系統 |
| **ioredis** (v5.9.1) | BullMQ 使用的 Redis 客戶端 |
| **redis** (v5.10.0) | 主要 Redis 客戶端（任務存儲與鎖定） |
| **mongoose** (v9.1.3) | MongoDB ORM |
| **telegraf** (v4.16.3) | Telegram Bot 框架 |
| **ethers** (v6.16.0) | Ethereum/Polygon 智能合約互動 |
| **axios** (v1.13.2) | HTTP 客戶端 |

---

## 環境變數配置

```env
TELEGRAM_BOT_TOKEN          # Telegram Bot API Token (必填)
REDIS_HOST                  # Redis 主機名 (必填)
REDIS_PORT                  # Redis 端口 (必填)
REDIS_PASSWORD              # Redis 密碼 (選填)
MONGODB_URI                 # MongoDB 連線字串 (必填)
POLYMARKET_CLOB_HTTP_URL    # CLOB API URL (預設: https://clob.polymarket.com)
RPC_URL                     # Polygon RPC URL (必填)
```

---

## 完整執行流程

### 1. 應用程式啟動流程 (`src/index.ts`)

```
main()
  │
  ├─ 1. validateConfig()           # 驗證環境變數配置
  │
  ├─ 2. initClobClient()           # 初始化 Polymarket CLOB 客戶端（唯讀）
  │
  ├─ 3. getRedisClient()           # 建立 Redis 連線
  │
  ├─ 4. connectToMongoDB()         # 建立 MongoDB 連線
  │
  ├─ 5. clearAllRepeatableJobs()   # 清理上次運行殘留的 zombie jobs
  │
  ├─ 6. performStartupChecks()     # 執行健康檢查（Data API & CLOB API）
  │
  ├─ 7. startTaskWorker()          # 啟動任務 Worker
  │     └─ 恢復所有 status='running' 的任務排程
  │     └─ 對每個任務執行 syncPositions() 關閉孤立倉位
  │
  ├─ 8. createBot()                # 創建 Telegram Bot 實例
  │
  ├─ 9. 註冊關閉信號處理器          # 監聽 SIGINT / SIGTERM
  │
  └─ 10. bot.launch()              # 啟動 Bot
```

### 2. 關閉流程 (`shutdown()`)

```
收到 SIGINT 或 SIGTERM
  │
  ├─ stopBot()                # 停止 Telegram Bot
  │
  ├─ stopTaskWorker()         # 停止任務 Worker
  │
  ├─ closeRedisConnection()   # 關閉 Redis 連線
  │
  ├─ closeMongoDBConnection() # 關閉 MongoDB 連線
  │
  └─ process.exit(0)          # 正常退出
```

---

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

## 任務生命週期

### 任務創建流程

```
/start 或 /mock 指令
  │
  ├─ 1. 生成唯一 UUID 作為任務 ID
  │
  ├─ 2. 創建模擬錢包地址 (ethers.Wallet.createRandom())
  │
  ├─ 3. 將任務存入 Redis Hash (copy-polymarket:tasks)
  │
  ├─ 4. 透過 BullMQ 排程重複執行任務（每 5 秒）
  │
  └─ 5. 返回任務 ID 給用戶
```

### 任務數據結構 (`CopyTask`)

```typescript
interface CopyTask {
  id: string;                    // UUID v4
  type: 'live' | 'mock';         // 交易模式
  address: string;               // 被跟單者錢包地址
  wallet: string;                // 生成的代理錢包地址
  url: string;                   // Polymarket 活動頁面 URL
  initialFinance: number;        // 初始資金
  currentBalance: number;        // 當前餘額
  fixedAmount: number;           // 固定交易金額
  duplicate: boolean;            // 是否處理重複交易
  status: 'running' | 'stopped'; // 任務狀態
  createdAt: number;             // 創建時間戳
  privateKey?: string;           // 僅 Live 模式
  rpcUrl?: string;               // 僅 Live 模式
}
```

---

## 任務執行流程（每 5 秒）

```
BullMQ Worker 從佇列取出任務
  │
  ├─ 1. 嘗試獲取分散式鎖 (taskLock)
  │     ├─ 鎖定成功 → 繼續執行
  │     └─ 鎖定失敗 → 跳過本次循環（防止並發）
  │
  ├─ 2. syncTradeData() - 同步交易數據
  │     ├─ 從 Polymarket API 抓取活動記錄
  │     │   GET https://data-api.polymarket.com/activity?user={address}
  │     ├─ 只處理最近 1 小時的活動
  │     ├─ 標記重複 conditionId 為 bot 活動
  │     ├─ 創建 UserActivity 記錄到 MongoDB
  │     └─ 跳過已存在的記錄（以 transactionHash 判斷）
  │
  ├─ 3. 獲取待處理交易
  │     └─ UserActivity.find({ bot: false, taskId })
  │
  ├─ 4. 處理每筆交易
  │     ├─ BUY  → handleBuyTrade()
  │     ├─ SELL → handleSellTrade()
  │     └─ REDEEM → handleRedeemTrade()
  │
  ├─ 5. 每 30 次執行一次倉位同步
  │     └─ syncPositions() - 關閉孤立倉位
  │
  └─ 6. 釋放分散式鎖
```

---

## 交易邏輯詳解

### BUY 交易流程 (`handleBuyTrade`)

```
檢查前置條件
  ├─ 該 condition 沒有現有倉位（防止重複建倉）
  ├─ 價格 ≤ 0.99（避免高價資產）
  └─ 餘額充足
  │
  ▼
計算下單金額
  ├─ 預設使用固定金額 (fixedAmount)
  ├─ 餘額不足時：使用可用餘額的 99%
  └─ 低於 $1 最低金額則跳過
  │
  ▼
模擬訂單執行（訂單簿模擬）
  ├─ 獲取 CLOB 訂單簿
  ├─ 遍歷賣單（按價格從低到高排序）
  ├─ 計算加權平均成交價
  ├─ 檢查滑點 < 5%
  └─ 返回：成交價、代幣數量、USDC 花費、滑點%
  │
  ▼
創建倉位記錄
  └─ 插入/更新 MyPosition 文檔
     追蹤：size, avgPrice, initialValue 等
  │
  ▼
創建 Mock 交易記錄
  └─ 存入 mockTradeRecrod 集合
     關聯 sourceActivityId
  │
  ▼
更新任務餘額 & 標記活動為已處理
```

### SELL 交易流程 (`handleSellTrade`)

```
檢查前置條件
  ├─ 存在對應倉位
  └─ 倉位數量 > 0
  │
  ▼
計算賣出數量
  ├─ 若被跟單者仍有剩餘倉位：按比例賣出
  │   公式：sellRatio = soldTokens / (soldTokens + remainingTokens)
  └─ 若被跟單者已清倉：全部賣出
  │
  ▼
模擬賣出訂單（最少 1 個代幣）
  ├─ 獲取訂單簿買單（按價格從高到低排序）
  ├─ 匹配可用買單流動性
  ├─ 計算加權平均成交價
  └─ 返回：成交價、成交代幣數、收到 USDC、滑點%
  │
  ▼
計算已實現損益
  ├─ soldCost = tokens * avgPrice（成本）
  └─ realizedPnL = usdcReceived - soldCost
  │
  ▼
更新倉位
  ├─ 完全平倉：刪除倉位文檔
  └─ 部分平倉：更新 size 和累計 realizedPnL
  │
  ▼
記錄交易 & 更新任務餘額
```

### REDEEM 交易流程 (`handleRedeemTrade`)

```
觸發條件：被跟單者活動顯示市場已結算
  │
  ▼
檢查鏈上賠付比率
  └─ 調用 CTF 合約 getOutcomePayoutRatio(conditionId, outcomeIndex)
     需要 RPC URL 進行智能合約調用
  │
  ▼
計算贖回價值
  ├─ redeemValue = positionSize * payoutRatio
  └─ realizedPnL = redeemValue - (size * avgPrice)
  │
  ▼
執行贖回
  │
  ├─【Mock 模式】
  │   ├─ 記錄贖回到 mockTradeRecrod
  │   ├─ 從 MyPosition 刪除倉位
  │   └─ 將贖回 USDC 加入任務餘額
  │
  └─【Live 模式】
      ├─ 使用 privateKey 創建 ethers wallet
      ├─ 調用 CTF 合約 redeemPositions() 函數
      ├─ 傳入 USDC 地址和 conditionId
      ├─ Gas Price 設為當前價格的 120%
      ├─ 等待交易確認
      └─ 成功後刪除倉位
```

---

## 倉位管理

### 倉位同步流程 (`syncPositions`)

每 30 次任務執行觸發一次（約 150 秒）：

```
1. 獲取我的倉位
   ├─ Mock 模式：從 MongoDB 查詢
   └─ Live 模式：從 Polymarket API 獲取

2. 獲取被跟單者當前倉位
   └─ GET https://data-api.polymarket.com/positions?user={address}&redeemable=false&limit=500

3. 對比每個我的倉位
   │
   ├─ 若被跟單者倉位不存在或 size=0：
   │   └─ 調用 forcedClosePosition()
   │       ├─ 嘗試在訂單簿上賣出（若市場仍活躍）
   │       └─ 若無買單：嘗試贖回
   │
   └─ 更新任務餘額
```

---

## Mock vs Live 模式對比

| 面向 | Mock 模式 | Live 模式 |
|------|-----------|-----------|
| **錢包** | 生成的隨機錢包 | 用戶提供 privateKey |
| **倉位存儲** | MongoDB (`MyPosition`) | Polymarket API 查詢 |
| **交易執行** | 訂單簿模擬 | 實際鏈上交易 |
| **贖回** | 模擬賠付比率計算 | 調用 CTF 智能合約 |
| **餘額追蹤** | 任務物件中更新 | N/A（使用實際錢包） |
| **交易記錄** | 完整歷史記錄 | 最小化追蹤 |

---

## 資料庫 Schema

### UserActivity（被跟單者活動記錄）

```javascript
{
  proxyWallet: String,         // 索引
  timestamp: Number,
  conditionId: String,
  type: String,
  size: Number,
  usdcSize: Number,
  transactionHash: String,     // 唯一索引
  price: Number,
  asset: String,
  side: String,                // BUY/SELL/REDEEM
  outcomeIndex: Number,
  title, slug, icon, outcome, eventSlug: String,
  name, pseudonym, bio, profileImage: String,
  bot: Boolean,                // false=待處理, true=已處理
  botExcutedTime: Number,      // 0=待處理, 1=處理中, 888=完成
  taskId: String,              // 索引
}
```

### MyPosition（Bot 模擬倉位）

```javascript
{
  proxyWallet: String,                    // 索引
  asset: String,
  conditionId: String,
  size: Number,
  avgPrice: Number,
  initialValue: Number,
  currentValue: Number,
  cashPnl: Number,
  percentPnl: Number,
  totalBought: Number,
  realizedPnl: Number,
  percentRealizedPnl: Number,
  curPrice: Number,
  redeemable, mergeable: Boolean,
  title, slug, icon, outcome: String,
  eventSlug: String,
  outcomeIndex: Number,
  oppositeOutcome, oppositeAsset: String,
  endDate: String,
  negativeRisk: Boolean,
  taskId: String,                         // 索引，唯一鍵的一部分
  // 唯一索引：(proxyWallet, asset, conditionId, taskId)
}
```

### mockTradeRecrod（Mock 交易記錄）

```javascript
{
  taskId: String,              // 索引
  side: String,                // BUY/SELL/REDEEM
  proxyWallet: String,         // 索引
  asset: String,
  conditionId: String,         // 索引
  outcomeIndex: Number,
  fillPrice: Number,
  fillSize: Number,
  usdcAmount: Number,
  slippage: Number,
  costBasisPrice: Number,
  soldCost: Number,
  realizedPnl: Number,
  positionSizeBefore: Number,
  positionSizeAfter: Number,
  sourceActivityId: ObjectId,  // 關聯 UserActivity
  sourceTransactionHash: String,
  sourceTimestamp: Number,
  executedAt: Number,
  title, slug, eventSlug, outcome: String,
}
```

---

## Redis 使用模式

### 數據存儲

- **Tasks Hash:** `copy-polymarket:tasks`
  - Key: 任務 ID (UUID)
  - Value: JSON 序列化的 CopyTask 物件
  - 操作: HSET, HGET, HGETALL, HDEL

### 分散式鎖定

- **Lock Key:** `copy-polymarket:task-lock:{taskId}`
  - Value: UUID token
  - TTL: 10 分鐘（自動過期）
  - 釋放: Lua 腳本（原子性比對刪除）
  - 防止同一任務並發執行

### BullMQ 佇列

- **Queue Name:** `task-queue`
- **Job Type:** `process-task`
- **Repeatable Schedule:** 每 5000ms（5 秒）
- **Concurrency:** 5 個 workers
- **Retry Policy:** 3 次重試，指數退避
- **Cleanup:** 完成後保留 100 個，失敗保留 50 個

---

## Polymarket API 整合

### Data API 端點

```
# 活動記錄
GET https://data-api.polymarket.com/activity?user={address}
Response: 交易者活動陣列

# 倉位查詢
GET https://data-api.polymarket.com/positions?user={address}&redeemable=false&limit=500
Response: 持倉陣列
```

### CLOB API

```
# 訂單簿
GET {clobHttpUrl}/orderbook/{tokenId}
Response: { asks: [{price, size}], bids: [{price, size}] }
```

---

## 鏈上操作（Live 模式）

### 智能合約

- **CTF Address:** `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- **USDC Address:** `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- **Network:** Polygon (chainId 137)

### 贖回流程

```javascript
1. Provider: ethers.JsonRpcProvider
2. Wallet: ethers.Wallet（基於 privateKey）
3. Call: ctfContract.redeemPositions()
4. Parameters:
   - collateralToken: USDC 地址
   - parentCollectionId: ZeroHash
   - conditionId: bytes32（填充後）
   - indexSets: 結果索引陣列
5. Gas: 限制 500,000，價格設為當前的 120%
6. 等待確認（status === 1）
```

---

## 錯誤處理與容錯

### 網路重試 (`fetchData.ts`)

- 自動重試網路錯誤（ETIMEDOUT, ECONNRESET, ECONNREFUSED）
- 指數退避: 1s, 2s, 4s
- 最多 3 次嘗試
- 強制 IPv4（避免 IPv6 問題）
- 10 秒請求超時

### 任務鎖定

- 防止並發執行
- 10 分鐘後自動釋放
- UUID token 匹配安全釋放

### 滑點保護

- BUY 訂單滑點 > 5% 則拒絕
- SELL 訂單允許任意滑點
- 強制最小訂單金額（$1 USD, 1 token）

---

## 工具腳本

| 腳本 | 用途 |
|------|------|
| `printBids.ts` | 獲取並顯示資產訂單簿 |
| `redeemCheck.ts` | 檢查贖回資格和賠付比率 |
| `clearTaskLocks.ts` | 清理卡住的 Redis 鎖 |
| `showTasksAndPositions.ts` | 顯示任務狀態和倉位詳情 |
| `analyzeTaskLoss.ts` | 分析任務執行和識別損失 |

---

## 執行流程圖

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              啟動流程                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  Validate Config → Init CLOB → Connect Redis → Connect MongoDB          │
│       ↓                                                                  │
│  Clear Zombie Jobs → Health Checks → Start Worker → Launch Bot          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      每 5 秒任務執行循環                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Worker 從 BullMQ 取任務                                              │
│  2. 嘗試獲取任務鎖                                                       │
│     ├─ 鎖定失敗 → 跳過本次                                               │
│     └─ 鎖定成功 ↓                                                        │
│        a. 同步交易數據（Polymarket API → MongoDB）                        │
│        b. 獲取待處理交易（bot=false）                                     │
│        c. 處理每筆交易：                                                  │
│           ├─ BUY: 檢查價格 → 模擬訂單 → 創建倉位                          │
│           ├─ SELL: 計算比例 → 模擬賣出 → 更新倉位                         │
│           └─ REDEEM: 獲取賠付 → 記錄贖回                                  │
│        d. 每 30 次：同步倉位（關閉孤立倉位）                               │
│        e. 釋放鎖                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            任務管理                                      │
├─────────────────────────────────────────────────────────────────────────┤
│  /start  → 創建 Live 任務                                                │
│  /mock   → 創建 Mock 任務                                                │
│  /list   → 顯示運行中任務                                                │
│  /stop   → 暫停任務                                                      │
│  /remove → 刪除任務與數據                                                │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 效能特性

| 項目 | 數值 |
|------|------|
| 任務執行頻率 | 每 5 秒 |
| 倉位同步頻率 | 每 150 秒（30 次執行） |
| 最大並發數 | 5 個任務同時處理 |
| 數據保留 | 無限期（無自動清理） |
| 鎖定 TTL | 10 分鐘（防止死鎖） |
| 交易確認 | 即時（下次執行循環） |

---

## 各組件職責

| 組件 | 職責 |
|------|------|
| **bot/index.ts** | Telegram 用戶介面與指令處理 |
| **taskService.ts** | 任務 CRUD、Redis 持久化、任務排程 |
| **tradeService.ts** | 交易邏輯、訂單模擬、倉位管理 |
| **task.worker.ts** | 任務處理器、交易執行編排 |
| **queue.ts** | BullMQ 設置、任務排程基礎設施 |
| **taskLock.ts** | 分散式互斥鎖 |
| **polymarket.ts** | CLOB 客戶端初始化、API 健康檢查 |
| **redeem.ts** | 鏈上贖回合約互動 |
| **fetchData.ts** | HTTP 請求與重試邏輯 |
| **Models** | MongoDB Schema 定義 |
