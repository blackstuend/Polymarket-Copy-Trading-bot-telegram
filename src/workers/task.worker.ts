import { Job, Worker } from 'bullmq';
import { getTask, listTasks, updateTask } from '../services/taskService.js';
import { scheduleTaskJob, createWorker, TaskJobData, QUEUE_NAMES } from '../services/queue.js';
import { withTaskLock } from '../services/taskLock.js';
import { CopyTask } from '../types/task.js';
import {
  closePositionOnStartup,
  getCopyTraderPositions,
  getMyPositions,
  getPendingTrades,
  handleBuyTrade,
  handleRedeemTrade,
  handleSellTrade,
  syncTradeData,
} from '../services/tradeService.js';
import { UserActivity } from '../models/UserActivity.js';
import { getClobClient } from '../services/polymarket.js';

let worker: Worker<TaskJobData> | null = null;

export async function startTaskWorker(): Promise<Worker<TaskJobData>> {
  if (!worker) {
    // 1. Restore scheduled jobs for all running tasks
    console.log('🔄 Restoring task schedules...');
    const runningTasks = await listTasks(); 

    let restoredCount = 0;
    for (const task of runningTasks) {
      if (task.status === 'running') {
        await reconcilePositionsOnStartup(task);
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

async function reconcilePositionsOnStartup(task: CopyTask): Promise<void> {
  try {
    const myPositions = await getMyPositions(task);
    if (myPositions.length === 0) {
      return;
    }

    const copyTraderPositions = await getCopyTraderPositions(task.address);
    const copyPositionsByCondition = new Map(
      copyTraderPositions.map((position) => [position.conditionId, position])
    );

    const client = getClobClient();
    let closedCount = 0;

    // Prepare live config if available
    const liveConfig = task.type === 'live' && task.privateKey && task.rpcUrl
      ? { privateKey: task.privateKey, rpcUrl: task.rpcUrl }
      : undefined;

    for (const myPosition of myPositions) {
      const copyTraderPosition = copyPositionsByCondition.get(myPosition.conditionId);
      if (!copyTraderPosition || copyTraderPosition.size <= 0) {
        const received = await closePositionOnStartup(client, task, myPosition, liveConfig);
        if (received > 0) {
          task.currentBalance += received;
          await updateTask(task);
        }
        closedCount++;
      }
    }

    if (closedCount > 0) {
      console.log(`[Task ${task.id}] Startup sync closed ${closedCount} position(s)`);
    }
  } catch (error) {
    console.error(`[Task ${task.id}] Error during startup position sync:`, error);
  }
}

async function processJob(job: Job<TaskJobData>): Promise<void> {
  const { taskId } = job.data;

  if (!taskId) {
    console.error(`❌ Job ${job.id} has no taskId! Data:`, job.data);
    return;
  }

  const ran = await withTaskLock(taskId, async () => {
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
  });

  if (!ran) {
    console.log(`[Task ${taskId}] Previous run still active, skipping this interval`);
  }
}



async function executeTask(task: CopyTask): Promise<void> {
  await syncTradeData(task);

  try {
    const trades = await getPendingTrades(task.id);

    if (trades.length === 0) {
      return;
    }

    console.log(`[Task ${task.id}] Found ${trades.length} pending trade(s)`);

    // Get my positions (from DB for mock, from API for live)
    const myPositions = await getMyPositions(task);

    // Get copy trader's current positions from API
    const copyTraderPositions = await getCopyTraderPositions(task.address);

    // Get CLOB client for orderbook simulation
    const client = getClobClient();

    for (const trade of trades) {
      // Mark as processing to avoid duplicate processing
      await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 1 });

      const myPosition = myPositions.find((pos) => pos.conditionId === trade.conditionId);
      const copyTraderPosition = copyTraderPositions.find((pos) => pos.conditionId === trade.conditionId);

      const tradeAction = trade.side || trade.type || 'UNKNOWN';
      const tradeLabel = trade.slug || trade.conditionId || 'unknown';

      console.log(`[Task ${task.id}] Processing ${tradeAction} trade: ${tradeLabel}`);
      if (tradeAction === 'BUY' || tradeAction === 'SELL') {
        console.log(`  - Trade size: ${trade.size} tokens, USDC: $${trade.usdcSize.toFixed(2)}, Price: $${trade.price.toFixed(4)}`);
      } else if (tradeAction === 'REDEEM') {
        console.log(`  - Redeem event detected`);
      }

      if (tradeAction === 'BUY') {
        // BUY logic: Skip if already have position
        if (myPosition && myPosition.size > 0) {
          console.log(`  - Skipping: Already have position (${myPosition.size.toFixed(2)} tokens)`);
          await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 888, bot: true });
          continue;
        }

        const spent = await handleBuyTrade(client, trade, task, myPosition);
        if (spent > 0) {
          task.currentBalance -= spent;
          await updateTask(task);
          console.log(`  - Balance updated: $${task.currentBalance.toFixed(2)}`);
        }
      } else if (tradeAction === 'SELL') {
        // SELL logic: Skip if no position to sell
        if (!myPosition || myPosition.size <= 0) {
          console.log(`  - Skipping: No position to sell`);
          await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 888, bot: true });
          continue;
        }

        const received = await handleSellTrade(client, trade, task, myPosition, copyTraderPosition);
        if (received > 0) {
          task.currentBalance += received;
          await updateTask(task);
          console.log(`  - Balance updated: $${task.currentBalance.toFixed(2)}`);
        }
      } else if (tradeAction === 'REDEEM') {
        const redeemed = await handleRedeemTrade(trade, task, myPosition);
        if (redeemed > 0) {
          task.currentBalance += redeemed;
          await updateTask(task);
          console.log(`  - Balance updated: $${task.currentBalance.toFixed(2)}`);
        }
      } else {
        console.log(`  - Unknown trade action: side=${trade.side || '""'} type=${trade.type || '""'}`);
        await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 888, bot: true });
      }
    }
  } catch (error) {
    console.error(`Error getting pending trades for task ${task.id}:`, error);
  }
}

export async function stopTaskWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log('Task worker stopped');
  }
}
