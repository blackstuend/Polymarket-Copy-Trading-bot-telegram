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


