import { Job, Worker } from 'bullmq';
import { Wallet } from '@ethersproject/wallet';
import { ethers } from 'ethers';
import { getTask, listTasks, updateTask } from '../services/taskService.js';
import { scheduleTaskJob, createWorker, TaskJobData, QUEUE_NAMES } from '../services/queue.js';
import { withTaskLock, clearTaskLock } from '../services/taskLock.js';
import { CopyTask } from '../types/task.js';
import {
  forcedClosePosition,
  getPendingTrades,
  handleBuyTrade,
  handleLiveBuyTrade,
  handleLiveSellTrade,
  handleRedeemTrade,
  handleSellTrade,
  fetchNewTradeData,
} from '../services/tradeService.js';
import { getCopyTraderPositions } from '../utils/getCopyTraderPositions.js';
import { getMyPositions } from '../utils/getMyPositions.js';
import { UserActivity } from '../models/UserActivity.js';
import { getClobClient } from '../services/polymarket.js';
import { logger } from '../utils/logger.js';
import getMyBalance from '../utils/getMyBalance.js';

let worker: Worker<TaskJobData> | null = null;
const taskRunCounts = new Map<string, number>();
const syncEveryRuns = 30;

export async function startTaskWorker(): Promise<Worker<TaskJobData>> {
  if (!worker) {
    // 1. Restore scheduled jobs for all running tasks
    logger.info('🔄 Restoring task schedules...');
    const runningTasks = await listTasks(); 

    let restoredCount = 0;
    for (const task of runningTasks) {
      if (task.status === 'running') {
        await clearTaskLock(task.id);
        await syncPositions(task);
        await scheduleTaskJob(task.id);
        restoredCount++;
      }
    }
    logger.info(`✅ Restored ${restoredCount} running task schedules.`);

    // 2. Create worker to process the task jobs
    worker = createWorker<TaskJobData>(QUEUE_NAMES.TASK, processJob);
  }
  return worker;
}

async function syncPositions(task: CopyTask): Promise<void> {
  try {
    const myPositions = await getMyPositions(task);
    if (myPositions.length === 0) {
      return;
    }

    const copyTraderPositions = await getCopyTraderPositions(task.address);
    const copyPositionsByCondition = new Map(
      copyTraderPositions.map((position) => [position.conditionId, position])
    );

    let closedCount = 0;

    for (const myPosition of myPositions) {
      const copyTraderPosition = copyPositionsByCondition.get(myPosition.conditionId);
      if (!copyTraderPosition || copyTraderPosition.size <= 0) {
        const received = await forcedClosePosition(myPosition, task);
        if (received > 0) {
          if (task.type === 'mock') {
            task.currentBalance += received;
            await updateTask(task);
          }
        }
        closedCount++;
      }
    }

    if (closedCount > 0) {
      logger.info(`[Task ${task.id}] Position sync closed ${closedCount} position(s)`);
    }
  } catch (error) {
    logger.error({ err: error }, `[Task ${task.id}] Error during position sync`);
  }
}

async function processJob(job: Job<TaskJobData>): Promise<void> {
  const { taskId } = job.data;

  if (!taskId) {
    logger.error({ jobData: job.data }, `❌ Job ${job.id} has no taskId!`);
    return;
  }

  const ran = await withTaskLock(taskId, async () => {
    try {
      const task = await getTask(taskId);

      if (!task) {
        logger.warn(`⚠️ Task ${taskId} not found in Redis (maybe removed?)`);
        return;
      }

      if (task.status !== 'running') {
        logger.info(`ℹ️ Task ${taskId} is ${task.status}, skipping execution`);
        return;
      }

      const runCount = (taskRunCounts.get(taskId) ?? 0) + 1;
      taskRunCounts.set(taskId, runCount);
      if (runCount % syncEveryRuns === 0) {
        await syncPositions(task);
      }

      // Execute the task
      await executeTask(task);

    } catch (error) {
      logger.error({ err: error }, `❌ Error processing task ${taskId}`);
      throw error; // Re-throw to let BullMQ handle retries
    }
  });

  if (!ran) {
    logger.info(`[Task ${taskId}] Previous run still active, skipping this interval`);
  }
}



async function executeTask(task: CopyTask): Promise<void> {
  await fetchNewTradeData(task);

  try {
    // 當 live 初始資金為沒帶時, 則使用此方式
    if (task.type === 'live' && (task.initialFinance ?? 0) <= 0) {
      let walletFromKey: string | undefined;
      if (task.privateKey) {
        try {
          walletFromKey = new Wallet(task.privateKey).address;
        } catch (error) {
          logger.warn({ err: error }, `[Task ${task.id}] Invalid privateKey for balance fetch`);
        }
      }

      const wallet = walletFromKey ?? task.myWalletAddress;
      if (!wallet || !ethers.isAddress(wallet)) {
        logger.warn(`[Task ${task.id}] Live task missing wallet address for balance fetch`);
      } else {
        try {
          const balance = await getMyBalance(wallet);
          task.initialFinance = balance;
          if ((task.currentBalance ?? 0) <= 0) {
            task.currentBalance = balance;
          }
          await updateTask(task);
          logger.info(`[Task ${task.id}] Live initial balance set: $${balance.toFixed(2)}`);
        } catch (error) {
          logger.warn({ err: error }, `[Task ${task.id}] Failed to fetch live balance`);
        }
      }
    }

    const trackBalance = task.type === 'mock' || (task.initialFinance ?? 0) > 0;
    const trades = await getPendingTrades(task.id);

    if (trades.length === 0) {
      return;
    }

    if (task.type === 'live' && !task.privateKey) {
      logger.warn(`[Task ${task.id}] Live task missing privateKey; skipping trade execution`);
      return;
    }

    logger.info(`[Task ${task.id}] Found ${trades.length} pending trade(s)`);

    let myPositions = await getMyPositions(task);

    const copyTraderPositions = await getCopyTraderPositions(task.address);

    const client = getClobClient();

    for (const trade of trades) {
      await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 1 });

      const myPosition = myPositions.find((pos) => pos.conditionId === trade.conditionId);
      const copyTraderPosition = copyTraderPositions.find((pos) => pos.conditionId === trade.conditionId);

      const tradeAction = trade.side || trade.type || 'UNKNOWN';
      const tradeLabel = trade.slug || trade.conditionId || 'unknown';

      logger.info(`[Task ${task.id}] Processing ${tradeAction} trade: ${tradeLabel}`);
      if (tradeAction === 'BUY' || tradeAction === 'SELL') {
        logger.info(`  - Trade size: ${trade.size} tokens, USDC: $${trade.usdcSize.toFixed(2)}, Price: $${trade.price.toFixed(4)}`);
      } else if (tradeAction === 'REDEEM') {
        logger.info(`  - Redeem event detected`);
      }

      if (tradeAction === 'BUY') {
        // BUY logic: Skip if already have position
        if (myPosition && myPosition.size > 0) {
          logger.info(`  - Skipping: Already have position (${myPosition.size.toFixed(2)} tokens)`);
          await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 888, bot: true });
          continue;
        }

        const spent = task.type === 'live'
          ? await handleLiveBuyTrade(trade, task, myPosition)
          : await handleBuyTrade(client, trade, task, myPosition);
        if (spent > 0) {
          if (trackBalance) {
            const newBalance = (task.currentBalance ?? 0) - spent;
            task.currentBalance = newBalance;
            await updateTask(task);
            logger.info(`  - Balance updated: $${newBalance.toFixed(2)}`);
          }
          // Refresh positions after trade execution
          myPositions = await getMyPositions(task);
        }
      } else if (tradeAction === 'SELL') {
        // SELL logic: Skip if no position to sell
        if (!myPosition || myPosition.size <= 0) {
          logger.info(`  - Skipping: No position to sell`);
          await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 888, bot: true });
          continue;
        }

        const received = task.type === 'live'
          ? await handleLiveSellTrade(trade, task, myPosition, copyTraderPosition)
          : await handleSellTrade(client, trade, task, myPosition, copyTraderPosition);
        if (received > 0) {
          if (trackBalance) {
            const newBalance = (task.currentBalance ?? 0) + received;
            task.currentBalance = newBalance;
            await updateTask(task);
            logger.info(`  - Balance updated: $${newBalance.toFixed(2)}`);
          }
          // Refresh positions after trade execution
          myPositions = await getMyPositions(task);
        }
      } else if (tradeAction === 'REDEEM') {
        const redeemed = await handleRedeemTrade(trade, task, myPosition);
        if (redeemed > 0) {
          if (trackBalance) {
            const newBalance = (task.currentBalance ?? 0) + redeemed;
            task.currentBalance = newBalance;
            await updateTask(task);
            logger.info(`  - Balance updated: $${newBalance.toFixed(2)}`);
          }
        }
      } else {
        logger.info(`  - Unknown trade action: side=${trade.side || '""'} type=${trade.type || '""'}`);
        await UserActivity.updateOne({ _id: trade._id }, { botExcutedTime: 888, bot: true });
      }
    }
  } catch (error) {
    logger.error({ err: error }, `Error getting pending trades for task ${task.id}`);
  }
}

export async function stopTaskWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('Task worker stopped');
  }
}
