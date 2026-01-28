import { createClient, RedisClientType } from 'redis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  redisClient = createClient({
    url: config.redis.url,
  });

  redisClient.on('connect', () => {
    logger.info('✅ Redis connected');
  });

  redisClient.on('error', (err: Error) => {
    logger.error({ err }, '❌ Redis connection error');
  });

  await redisClient.connect();
  return redisClient;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  }
}
