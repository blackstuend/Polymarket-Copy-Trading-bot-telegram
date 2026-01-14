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
}
