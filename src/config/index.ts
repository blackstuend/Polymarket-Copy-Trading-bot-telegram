import 'dotenv/config';

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  redis: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  mongodb: {
    uri: process.env.MONGODB_URI,
  },
  polymarket: {
    clobHttpUrl: process.env.POLYMARKET_CLOB_HTTP_URL || 'https://clob.polymarket.com',
    rpcUrl: process.env.RPC_URL || '',
    chainId: 137, // Polygon mainnet
  },
} as const;

// Validate required environment variables
export function validateConfig(): void {
  if (!config.telegram.botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  if (!config.mongodb.uri) {
    throw new Error('MONGODB_URI is required');
  }
  if (!config.redis.host) {
    throw new Error('REDIS_HOST is required');
  }
  if (!config.redis.port) {
    throw new Error('REDIS_PORT is required');
  }
  if (!config.polymarket.rpcUrl) {
    throw new Error('RPC_URL is required');
  }
}
