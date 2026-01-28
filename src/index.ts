import { config, validateConfig } from './config/index.js';
import { createBot, stopBot } from './bot/index.js';
import { getRedisClient, closeRedisConnection } from './services/redis.js';
import { connectToMongoDB, closeMongoDBConnection } from './services/mongodb.js';
import { startTaskWorker, stopTaskWorker } from './workers/task.worker.js';
import { clearAllRepeatableJobs } from './services/queue.js';
import { performStartupChecks } from './services/healthCheck.js';
import { initClobClient } from './services/polymarket.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  logger.info('🚀 Starting application...');

  // Validate configuration
  validateConfig();
  
  logger.info('📡 Connecting to Redis...');
  logger.info('📡 Connecting to MongoDB...');

  // Initialize CLOB client early (used by workers)
  initClobClient();

  // Initialize Redis connection
  await getRedisClient();

  // Initialize MongoDB connection
  await connectToMongoDB();

  // Clean up any zombie jobs from previous runs
  await clearAllRepeatableJobs();

  // Perform startup checks
  await performStartupChecks();

  // Start task worker (restores schedules for running tasks)
  await startTaskWorker();

  // Create and launch bot
  const bot = createBot();

  // Enable graceful stop
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Start the bot
  await bot.launch();
  logger.info('🤖 Bot is running!');
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`\n${signal} received. Shutting down gracefully...`);

  try {
    await stopBot();
    await stopTaskWorker();
    await closeRedisConnection();
    await closeMongoDBConnection();
    logger.info('👋 Goodbye!');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error({ err: error }, '❌ Fatal error');
  process.exit(1);
});
