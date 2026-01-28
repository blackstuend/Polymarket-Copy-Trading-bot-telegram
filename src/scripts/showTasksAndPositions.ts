import 'dotenv/config';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { MyPosition } from '../models/MyPosition.js';
import { logger } from '../utils/logger.js';

const TASKS_KEY = 'copy-polymarket:tasks';

type TaskRecord = {
  id: string;
  type: 'live' | 'mock';
  address: string;
  wallet?: string;
  url: string;
  initialFinance: number;
  currentBalance: number;
  fixedAmount: number;
  duplicate: boolean;
  status: 'running' | 'stopped';
  createdAt: number;
  privateKey?: string;
};

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}%`;
}

function formatIso(timestampMs?: number): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return 'n/a';
  return new Date(timestampMs).toISOString().replace('T', ' ');
}

function sanitizeTask(task: TaskRecord): TaskRecord {
  if (!task.privateKey) return task;
  const suffix = task.privateKey.slice(-4);
  return {
    ...task,
    privateKey: `***${suffix}`,
  };
}

function positionLabel(pos: { title?: string; slug?: string; conditionId?: string }): string {
  return pos.title || pos.slug || pos.conditionId || 'unknown';
}

async function main(): Promise<void> {
  const targetTaskId = process.argv[2];

  const redisHost = process.env.REDIS_HOST;
  const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
  if (!redisHost) {
    logger.error('REDIS_HOST is not set in the environment.');
    process.exit(1);
  }

  const redis = createClient({
    socket: { host: redisHost, port: redisPort },
    password: process.env.REDIS_PASSWORD || undefined,
  });
  redis.on('error', (err) => logger.error({ err }, 'Redis error'));

  await redis.connect();
  const tasksMap = await redis.hGetAll(TASKS_KEY);
  await redis.quit();

  const allTasks = Object.values(tasksMap).map((raw) => JSON.parse(raw) as TaskRecord);
  const tasks = targetTaskId
    ? allTasks.filter((task) => task.id === targetTaskId)
    : allTasks;

  if (tasks.length === 0) {
    logger.info('No tasks found.');
    return;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    logger.error('MONGODB_URI is not set in the environment.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  try {
    logger.info(`Tasks: ${tasks.length}`);

    const sortedTasks = [...tasks].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    for (const task of sortedTasks) {
      const safeTask = sanitizeTask(task);
      logger.info('');
      logger.info(`Task ${safeTask.id}`);
      logger.info(JSON.stringify(safeTask, null, 2));

      const positions = await MyPosition.find({ taskId: task.id }).lean();
      if (positions.length === 0) {
        logger.info('Positions: none');
        continue;
      }

      let openPositions = 0;
      let totalPositionValue = 0;
      let totalCostBasis = 0;

      const positionLines: string[] = [];
      for (const pos of positions) {
        const size = typeof pos.size === 'number' ? pos.size : 0;
        if (size <= 0) continue;
        openPositions += 1;

        const avgPrice = Number.isFinite(pos.avgPrice) ? pos.avgPrice : 0;
        const curPrice = Number.isFinite(pos.curPrice) ? pos.curPrice : avgPrice;
        const currentValue = Number.isFinite(pos.currentValue)
          ? pos.currentValue
          : size * curPrice;
        const costBasis = Number.isFinite(pos.totalBought) && pos.totalBought > 0
          ? pos.totalBought
          : Number.isFinite(pos.initialValue) && pos.initialValue > 0
            ? pos.initialValue
            : avgPrice * size;

        totalPositionValue += currentValue;
        totalCostBasis += costBasis;

        const cashPnl = currentValue - costBasis;
        const percentPnl = costBasis > 0 ? (cashPnl / costBasis) * 100 : null;
        const realizedPnl = Number.isFinite(pos.realizedPnl) ? pos.realizedPnl : 0;
        const label = positionLabel(pos);

        positionLines.push(
          `${label} | size ${size.toFixed(2)} @${avgPrice.toFixed(4)} | ` +
          `value ${formatUsd(currentValue)} | uPnL ${formatUsd(cashPnl)} (${formatPct(percentPnl)}) | ` +
          `rPnL ${formatUsd(realizedPnl)}`
        );
      }

      logger.info(`Positions: ${openPositions}`);
      logger.info(`  totalPositionValue: ${formatUsd(totalPositionValue)}`);
      logger.info(`  totalCostBasis: ${formatUsd(totalCostBasis)}`);
      logger.info(`  unrealizedPnl: ${formatUsd(totalPositionValue - totalCostBasis)}`);
      logger.info('Position details:');
      for (const line of positionLines) {
        logger.info(`  - ${line}`);
      }

      const equity = (task.currentBalance || 0) + totalPositionValue;
      const totalPnl = equity - (task.initialFinance || 0);
      const pnlPct = task.initialFinance > 0 ? (totalPnl / task.initialFinance) * 100 : null;
      logger.info(`Equity: ${formatUsd(equity)} | PnL: ${formatUsd(totalPnl)} (${formatPct(pnlPct)})`);
      logger.info(`CreatedAt: ${formatIso(task.createdAt)}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Show tasks failed');
  process.exit(1);
});
