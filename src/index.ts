import { validateConfig } from './config/index.js';
import { createBot, stopBot } from './bot/index.js';
import { getRedisClient, closeRedisConnection } from './services/redis.js';
import { connectToMongoDB, closeMongoDBConnection } from './services/mongodb.js';
import { startTaskWorker, stopTaskWorker } from './workers/task.worker.js';
import { clearAllRepeatableJobs } from './services/queue.js';
import { performStartupChecks } from './services/healthCheck.js';

async function main(): Promise<void> {
  console.log('🚀 Starting application...');

  // Validate configuration
  validateConfig();

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
  console.log('🤖 Bot is running!');
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  try {
    await stopBot();
    await stopTaskWorker();
    await closeRedisConnection();
    await closeMongoDBConnection();
    console.log('👋 Goodbye!');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
