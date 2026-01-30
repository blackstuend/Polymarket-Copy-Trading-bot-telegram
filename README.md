# Copy-Polymarket Trading Bot

Polymarket 跟單交易機器人，支援 Mock（模擬）和 Live（實盤）交易模式，透過 Telegram 進行操作控制。

## Telegram Bot 指令

| 指令 | 參數 | 說明 |
|------|------|------|
| `/help` | - | 顯示指令說明 |
| `/start` | `<address> <url> <amount> <myWalletAddress> <privateKey>` | 創建實盤跟單任務 |
| `/mock` | `<address> <url> <finance> <amount>` | 創建模擬跟單任務 |
| `/list` | - | 顯示所有實盤任務 |
| `/list_mock` | - | 顯示模擬任務詳細統計 |
| `/stop` | `<id>` | 停止任務（保留數據） |
| `/remove` | `<id>` 或 `all` | 刪除任務與相關數據 |
| `/ping` | - | 健康檢查 |

## Redis Pub/Sub API

本機器人支援透過 Redis Pub/Sub 接收任務指令，適合與其他服務整合。

### 頻道

| 頻道名稱 | 用途 |
|---------|------|
| `copy-polymarket:tasks:incoming` | 接收任務指令（訂閱端） |
| `copy-polymarket:notifications` | 發送執行結果通知（發布端） |

### 訊息格式

所有訊息皆為 JSON 格式。

#### 1. 新增模擬任務 (Add Mock Task)

```json
{
  "action": "add",
  "type": "mock",
  "address": "0x...",
  "profile": "https://polymarket.com/profile/xxx",
  "fixedAmount": 100,
  "initialAmount": 1000
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `action` | string | 固定為 `"add"` |
| `type` | string | 固定為 `"mock"` |
| `address` | string | 跟單目標的錢包地址 |
| `profile` | string | 跟單目標的 Polymarket 個人檔案 URL |
| `fixedAmount` | number | 每筆交易的固定金額 |
| `initialAmount` | number | 初始模擬資金 |

#### 2. 新增實盤任務 (Add Live Task)

```json
{
  "action": "add",
  "type": "live",
  "address": "0x...",
  "profile": "https://polymarket.com/profile/xxx",
  "fixAmount": 100,
  "privateKey": "0x...",
  "myWalletAddress": "0x..."
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `action` | string | 固定為 `"add"` |
| `type` | string | 固定為 `"live"` |
| `address` | string | 跟單目標的錢包地址 |
| `profile` | string | 跟單目標的 Polymarket 個人檔案 URL |
| `fixAmount` | number | 每筆交易的固定金額 |
| `privateKey` | string | 你的錢包私鑰（需與 `myWalletAddress` 匹配） |
| `myWalletAddress` | string | 你的錢包地址 |

> ⚠️ **注意**: 實盤任務會驗證錢包餘額，需至少有 `fixAmount * 3` 的 USDC。

#### 3. 停止任務 (Stop Task)

```json
{
  "action": "stop",
  "taskId": "task-id-here"
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `action` | string | 固定為 `"stop"` |
| `taskId` | string | 要停止的任務 ID |

#### 4. 刪除任務 (Remove Task)

```json
{
  "action": "remove",
  "taskId": "task-id-here"
}
```

刪除所有任務：

```json
{
  "action": "remove"
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `action` | string | 固定為 `"remove"` |
| `taskId` | string \| undefined | 要刪除的任務 ID，若不傳則刪除所有任務 |

#### 5. 重啟任務 (Restart Task)

```json
{
  "action": "restart",
  "taskId": "task-id-here"
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `action` | string | 固定為 `"restart"` |
| `taskId` | string | 要重啟的任務 ID |

### 通知回應

系統會在 `copy-polymarket:notifications` 頻道發布執行結果：

```json
// 任務創建成功
{
  "event": "task_created",
  "taskId": "xxx",
  "type": "mock",
  "address": "0x...",
  "status": "running"
}

// 任務停止
{
  "event": "task_stopped",
  "taskId": "xxx",
  "success": true
}

// 任務刪除
{
  "event": "task_removed",
  "taskId": "xxx",
  "count": 1
}

// 任務重啟
{
  "event": "task_restarted",
  "taskId": "xxx",
  "success": true
}

// 錯誤
{
  "event": "task_error",
  "error": "錯誤訊息",
  "rawMessage": "原始訊息"
}
```
