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
export interface ExampleJobData {
  message: string;
  userId: number;
}

// Queue names
export const QUEUE_NAMES = {
  EXAMPLE: 'example-queue',
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
    concurrency: 5,
  });

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job?.id} failed:`, err.message);
  });

  console.log(`👷 Worker for "${name}" started`);
  return worker;
}

// Example queue instance
let exampleQueue: Queue<ExampleJobData> | null = null;

export function getExampleQueue(): Queue<ExampleJobData> {
  if (!exampleQueue) {
    exampleQueue = createQueue<ExampleJobData>(QUEUE_NAMES.EXAMPLE);
  }
  return exampleQueue;
}
