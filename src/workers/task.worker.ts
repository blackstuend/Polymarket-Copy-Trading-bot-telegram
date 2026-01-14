import { Job, Worker } from 'bullmq';
import { listTasks } from '../services/taskService.js';
import { scheduleTaskJob, createWorker, TaskJobData, QUEUE_NAMES } from '../services/queue.js';
import { getTask } from '../services/taskService.js';
import { CopyTask } from '../types/task.js';

let worker: Worker<TaskJobData> | null = null;

export async function startTaskWorker(): Promise<Worker<TaskJobData>> {
  if (!worker) {
    // 1. Restore scheduled jobs for all running tasks
    console.log('🔄 Restoring task schedules...');
    const runningTasks = await listTasks(); 

    // Note: listTasks returns all, filter for running if listTasks doesn't filter by status inside
    // Looking at taskService.ts, listTasks returns ALL or filters by TYPE. 
    // We should filter by status here effectively.

    let restoredCount = 0;
    for (const task of runningTasks) {
      if (task.status === 'running') {
        // We re-schedule it. 
        // Note: BullMQ is smart enough; if the same repeatable job (same ID/config) exists, it won't duplicate it.
        // But it's good practice to ensure they are there.
        await scheduleTaskJob(task.id);
        restoredCount++;
      }
    }
    console.log(`✅ Restored ${restoredCount} running task schedules.`);

    // 2. Create worker to process the task jobs
    worker = createWorker<TaskJobData>(QUEUE_NAMES.TASK, processJob);
  }
  return worker;
}

async function processJob(job: Job<TaskJobData>): Promise<void> {
  const { taskId } = job.data;
  // console.log(`🔄 [${new Date().toISOString()}] Processing task ${taskId}...`);

  if (!taskId) {
    console.error(`❌ Job ${job.id} has no taskId! Data:`, job.data);
    return;
  }

  try {
    const task = await getTask(taskId);

    if (!task) {
      console.warn(`⚠️ Task ${taskId} not found in Redis (maybe removed?)`);
      return;
    }

    if (task.status !== 'running') {
      console.log(`ℹ️ Task ${taskId} is ${task.status}, skipping execution`);
      return;
    }

    // Execute the task
    await executeTask(task);

  } catch (error) {
    console.error(`❌ Error processing task ${taskId}:`, error);
    throw error; // Re-throw to let BullMQ handle retries
  }
}

async function executeTask(task: CopyTask): Promise<void> {
  console.log(`  📋 Executing task ${task.id} (${task.address})`);
  // console.log(`     Type: ${task.type}`);
  // console.log(`     URL: ${task.url}`);

  // TODO: Add your actual task execution logic here
  // For example: fetch Polymarket data, execute copy trading, etc.
}

export async function stopTaskWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Task worker stopped');
  }
}
