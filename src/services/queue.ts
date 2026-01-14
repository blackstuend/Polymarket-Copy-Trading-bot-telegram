import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config/index.js';

// BullMQ requires ioredis, create dedicated connection
function createBullMQConnection(): Redis {
  return new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
    maxRetriesPerRequest: null, // Required for BullMQ
  });
}

// Define your job data types
export interface TaskJobData {
  taskId: string;
}

// Queue names
export const QUEUE_NAMES = {
  TASK: 'task-queue',
} as const;

// Create a queue
export function createQueue<T>(name: string): Queue<T> {
  const connection = createBullMQConnection();

  const queue = new Queue<T>(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    },
  });

  console.log(`📋 Queue "${name}" created`);
  return queue;
}

// Create a worker
export function createWorker<T>(
  name: string,
  processor: (job: Job<T>) => Promise<void>
): Worker<T> {
  const connection = createBullMQConnection();

  const worker = new Worker<T>(name, processor, {
    connection,
    concurrency: 5, // Process multiple tasks concurrently
  });

  worker.on('completed', (job) => {
    // console.log(`✅ Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job?.id} failed:`, err.message);
  });

  console.log(`👷 Worker for "${name}" started`);
  return worker;
}

// Task queue instance
let taskQueue: Queue<TaskJobData> | null = null;

export function getTaskQueue(): Queue<TaskJobData> {
  if (!taskQueue) {
    taskQueue = createQueue<TaskJobData>(QUEUE_NAMES.TASK);
  }
  return taskQueue;
}

// Schedule a repeating job for a specific task
export async function scheduleTaskJob(taskId: string, intervalMs: number = 5000): Promise<void> {
  const queue = getTaskQueue();
  
  // Create a predictable job ID for the repeatable job
  // Note: BullMQ generates its own IDs for repeatable jobs, but we can use this for reference
  // The 'repeat' option is what makes it unique mostly
  
  await queue.add(
    'process-task',
    { taskId },
    {
      jobId: `task:${taskId}`, // Base ID
      repeat: {
        every: intervalMs,
      },
    }
  );

  console.log(`⏰ Scheduled job for task ${taskId} (every ${intervalMs}ms)`);
}

// Helper to clear ALL repeatable jobs (useful for cleanup/debugging)
export async function clearAllRepeatableJobs(): Promise<void> {
  const queue = getTaskQueue();
  const repeatableJobs = await queue.getRepeatableJobs();
  
  console.log(`🧹 Found ${repeatableJobs.length} repeatable jobs to clear...`);
  
  for (const job of repeatableJobs) {
    await queue.removeRepeatableByKey(job.key);
  }
  
  console.log('✨ All repeatable jobs cleared.');
}

// Remove the repeating job for a task
export async function removeTaskJob(taskId: string, intervalMs: number = 5000): Promise<void> {
  const queue = getTaskQueue();
  
  // To remove, we generally need to match the configuration. 
  // For 'every', we provide the same configuration.
  await queue.removeRepeatable(
    'process-task',
    {
      every: intervalMs,
    },
    `task:${taskId}` // We used this jobId base when adding
  );

  console.log(`� Removed scheduled job for task ${taskId}`);
}
