import 'dotenv/config';
import { logger } from '../utils/logger.js';

const getRedisConfig = () => {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        url,
        host: parsed.hostname,
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
      };
    } catch (e) {
      logger.error('⚠️ Invalid REDIS_URL, falling back to env vars');
    }
  }
  return {
    url: '',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  };
};

const redisConfig = getRedisConfig();
const signatureTypeRaw = process.env.POLYMARKET_SIGNATURE_TYPE;
const signatureTypeParsed = signatureTypeRaw ? parseInt(signatureTypeRaw, 10) : 0;
const signatureType = Number.isFinite(signatureTypeParsed) ? signatureTypeParsed : 0;

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  },
  redis: redisConfig,
  mongodb: {
    uri: process.env.MONGO_URL || process.env.MONGODB_URI || '',
  },
  polymarket: {
    clobHttpUrl: process.env.POLYMARKET_CLOB_HTTP_URL || 'https://clob.polymarket.com',
    rpcUrl: process.env.RPC_URL || '',
    chainId: 137, // Polygon mainnet
    signatureType,
  },
} as const;

// Validate required environment variables
export function validateConfig(): void {
  if (!config.telegram.botToken) {
    logger.warn('⚠️ TELEGRAM_BOT_TOKEN is not set');
  }
  
  if (!config.mongodb.uri) {
    throw new Error('MONGO_URL is required');
  }

  if (!config.redis.url && !config.redis.host) {
    throw new Error('REDIS_URL or REDIS_HOST is required');
  }

  if (!config.polymarket.rpcUrl) {
    logger.warn('⚠️ RPC_URL is not set');
  }
}
