import { createClient, RedisClientType } from 'redis';
import { config } from '../config/index.js';

let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  if (config.redis.url) {
    redisClient = createClient({
      url: config.redis.url,
    });
  } else {
    redisClient = createClient({
      socket: {
        host: config.redis.host,
        port: config.redis.port,
      },
      password: config.redis.password,
      username: config.redis.user,
    });
  }

  redisClient.on('connect', () => {
    console.log('✅ Redis connected');
  });

  redisClient.on('error', (err: Error) => {
    console.error('❌ Redis connection error:', err);
  });

  await redisClient.connect();
  return redisClient;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
    console.log('Redis connection closed');
  }
}
