import { Job, Worker } from 'bullmq';
import { createWorker, ExampleJobData, QUEUE_NAMES } from '../services/queue.js';

let worker: Worker<ExampleJobData> | null = null;

export function startExampleWorker(): Worker<ExampleJobData> {
  if (!worker) {
    worker = createWorker<ExampleJobData>(
      QUEUE_NAMES.EXAMPLE,
      processExampleJob
    );
  }
  return worker;
}

async function processExampleJob(job: Job<ExampleJobData>): Promise<void> {
  console.log(`🔄 Processing job ${job.id}`);
  console.log(`   Message: ${job.data.message}`);
  console.log(`   User ID: ${job.data.userId}`);

  // Simulate some async work
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`✅ Job ${job.id} processed successfully`);
}

export async function stopExampleWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Example worker stopped');
  }
}
