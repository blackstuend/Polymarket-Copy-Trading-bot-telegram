import { Job, Worker } from 'bullmq';
import { listTasks, updateTask } from '../services/taskService.js';
import { scheduleTaskJob, createWorker, TaskJobData, QUEUE_NAMES } from '../services/queue.js';
import { getTask } from '../services/taskService.js';
import { CopyTask } from '../types/task.js';
import { syncTradeData } from '../services/tradeService.js';
import { getPendingTrades, getMyPositions } from '../services/tradeService.js';
import { UserActivity } from '../models/UserActivity.js';

let worker: Worker<TaskJobData> | null = null;

export async function startTaskWorker(): Promise<Worker<TaskJobData>> {
  if (!worker) {
    // 1. Restore scheduled jobs for all running tasks
    console.log('🔄 Restoring task schedules...');
    const runningTasks = await listTasks(); 

    let restoredCount = 0;
    for (const task of runningTasks) {
      if (task.status === 'running' || task.status === 'init') {
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

    if (task.status === 'init') {
      console.log(`ℹ️ Task ${taskId} is starting (init)...`);
      
      // Update status to running
      task.status = 'running';
      await updateTask(task);
      console.log(`✅ Task ${taskId} switched to running status`);
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
  await syncTradeData(task);

  // 取得哪些要來交易從 db 拿出來
  try {
    const trades = await getPendingTrades(task.id);
    // 檢查出哪些是不需要的交易的
    // 1. 我沒有的 position 2. 我已經交易過的, 只有 buy 3. 並算出比例
    const myPositions = await getMyPositions(task);

    for(const trade of trades) {
      const position = myPositions.find((pos) => pos.conditionId === trade.conditionId);
      // 有 position 且是 buy, 代表我已經交易過了
      if(position && trade.side === 'BUY') {
        trade.botExcutedTime = Math.floor(Date.now() / 1000);
        await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: trade.botExcutedTime, bot: true });
        continue;
      }

      // 沒有 position 且是 sell, 代表我沒有這個 position
      if(!position && trade.side === 'SELL') {
        trade.botExcutedTime = Math.floor(Date.now() / 1000);
        await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: trade.botExcutedTime, bot: true });
        continue;
      }

      // 有 position 且是 sell, 代表我需要去賣
      if (position && trade.side === 'SELL') {
        // 取得 copy trader 要賣出的比例根據他的 position
        const copyTraderPosition = myPositions.find((pos) => pos.conditionId === trade.conditionId);
        const copyTraderSellRatio =  trade.size / position.size;

        // 算出我的實際要賣出的 size
        const mySellSize = position.size * copyTraderSellRatio;
        
         // do the sell trade
      }

      // 買入
      // do the buy trade
    }
  } catch (error) {
    console.error(`❌ Error getting pending trades for task ${task.id}:`, error);
  }
}

export async function stopTaskWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Task worker stopped');
  }
}
