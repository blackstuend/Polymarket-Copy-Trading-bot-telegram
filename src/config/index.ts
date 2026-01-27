import 'dotenv/config';

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  redis: {
    url: process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL,
    host: process.env.REDISHOST || process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDISPORT || process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || process.env.REDISPASSWORD || undefined,
    user: process.env.REDISUSER || process.env.REDIS_USER || 'default',
  },
  mongodb: {
    uri: process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_PUBLIC_URL,
    host: process.env.MONGOHOST || 'localhost',
    port: parseInt(process.env.MONGOPORT || '27017', 10),
    user: process.env.MONGOUSER || '',
    password: process.env.MONGOPASSWORD || '',
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
    console.warn('⚠️ TELEGRAM_BOT_TOKEN is not set');
  }
  
  if (!config.mongodb.uri && !config.mongodb.host) {
    throw new Error('MongoDB connection parameters are required');
  }

  if (!config.redis.url && !config.redis.host) {
    throw new Error('Redis connection parameters are required');
  }

  if (!config.polymarket.rpcUrl) {
    console.warn('⚠️ RPC_URL is not set');
  }
}
