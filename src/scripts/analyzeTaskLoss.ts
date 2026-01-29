import 'dotenv/config';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { mockTradeRecrod } from '../models/mockTradeRecrod.js';
import { MyPosition } from '../models/MyPosition.js';
import { UserActivity } from '../models/UserActivity.js';
import { logger } from '../utils/logger.js';

const TASKS_KEY = 'copy-polymarket:tasks';

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(2)}`;
}

function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}%`;
}

function formatIso(timestampMs?: number): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return 'n/a';
  return new Date(timestampMs).toISOString().replace('T', ' ');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const taskId = argv[0];
  if (!taskId || taskId === '-h' || taskId === '--help') {
    logger.error('Usage: tsx src/scripts/analyzeTaskLoss.ts <taskId> [--all] [--limit N]');
    process.exit(1);
  }
  let limit = 25;
  let showAll = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      showAll = true;
      continue;
    }
    if (arg === '--limit') {
      const next = argv[i + 1];
      if (!next) {
        logger.error('Missing value for --limit');
        process.exit(1);
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        logger.error(`Invalid limit: ${next}`);
        process.exit(1);
      }
      limit = Math.floor(parsed);
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        logger.error(`Invalid limit: ${arg}`);
        process.exit(1);
      }
      limit = Math.floor(parsed);
      continue;
    }
  }

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
  const taskStr = await redis.hGet(TASKS_KEY, taskId);
  await redis.quit();

  if (!taskStr) {
    logger.error(`Task not found in Redis: ${taskId}`);
    process.exit(1);
  }

  const task = JSON.parse(taskStr) as {
    id: string;
    type: 'live' | 'mock';
    address: string;
    initialFinance?: number;
    currentBalance?: number;
    fixedAmount: number;
    createdAt: number;
  };

  logger.info('Task');
  logger.info(`  id: ${task.id}`);
  logger.info(`  type: ${task.type}`);
  logger.info(`  address: ${task.address}`);
  logger.info(`  createdAt: ${formatIso(task.createdAt)}`);
  logger.info(`  initialFinance: ${formatUsd(task.initialFinance ?? 0)}`);
  logger.info(`  currentBalance: ${formatUsd(task.currentBalance ?? 0)}`);
  logger.info(`  fixedAmount: ${formatUsd(task.fixedAmount)}`);

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    logger.error('MONGODB_URI is not set in the environment.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  try {
    const createdAtSec = Math.floor((task.createdAt || 0) / 1000);
    const [beforeCount, afterCount, pendingCount] = await Promise.all([
      UserActivity.countDocuments({ taskId, timestamp: { $lt: createdAtSec } }),
      UserActivity.countDocuments({ taskId, timestamp: { $gte: createdAtSec } }),
      UserActivity.countDocuments({ taskId, bot: false }),
    ]);

    const earliestActivity = await UserActivity.findOne({ taskId }).sort({ timestamp: 1 }).lean();
    const latestActivity = await UserActivity.findOne({ taskId }).sort({ timestamp: -1 }).lean();

    logger.info('Activity');
    logger.info(`  beforeCreatedAt: ${beforeCount}`);
    logger.info(`  afterCreatedAt: ${afterCount}`);
    logger.info(`  pendingBotFalse: ${pendingCount}`);
    if (earliestActivity?.timestamp) {
      logger.info(`  earliestTimestamp: ${new Date(earliestActivity.timestamp * 1000).toISOString().replace('T', ' ')}`);
    }
    if (latestActivity?.timestamp) {
      logger.info(`  latestTimestamp: ${new Date(latestActivity.timestamp * 1000).toISOString().replace('T', ' ')}`);
    }

    const tradeTotals = await mockTradeRecrod.aggregate<{
      _id: string | null;
      count: number;
      totalUsd: number;
    }>([
      { $match: { taskId } },
      {
        $group: {
          _id: '$side',
          count: { $sum: 1 },
          totalUsd: { $sum: '$usdcAmount' },
        },
      },
    ]);

    const totalsBySide = new Map<string, { count: number; totalUsd: number }>();
    for (const row of tradeTotals) {
      const key = (row._id ?? 'UNKNOWN').toString().toUpperCase();
      totalsBySide.set(key, {
        count: Number.isFinite(row.count) ? row.count : 0,
        totalUsd: Number.isFinite(row.totalUsd) ? row.totalUsd : 0,
      });
    }

    const buyTotals = totalsBySide.get('BUY') ?? { count: 0, totalUsd: 0 };
    const sellTotals = totalsBySide.get('SELL') ?? { count: 0, totalUsd: 0 };
    const redeemTotals = totalsBySide.get('REDEEM') ?? { count: 0, totalUsd: 0 };
    const unknownTotals = totalsBySide.get('UNKNOWN') ?? { count: 0, totalUsd: 0 };
    const otherTotals = Array.from(totalsBySide.entries())
      .filter(([side]) => !['BUY', 'SELL', 'REDEEM', 'UNKNOWN'].includes(side))
      .reduce(
        (acc, [, value]) => ({
          count: acc.count + value.count,
          totalUsd: acc.totalUsd + value.totalUsd,
        }),
        { count: 0, totalUsd: 0 }
      );

    const netCashFlow =
      -buyTotals.totalUsd + sellTotals.totalUsd + redeemTotals.totalUsd;
    const expectedBalance = (task.initialFinance ?? 0) + netCashFlow;
    const balanceGap = (task.currentBalance ?? 0) - expectedBalance;

    const tradeQuery = mockTradeRecrod.find({ taskId }).sort({ executedAt: 1 });
    if (!showAll) {
      tradeQuery.limit(limit);
    }
    const trades = await tradeQuery.lean();

    if (trades.length === 0) {
      logger.info('Mock trades: none');
    } else {
      if (showAll) {
        logger.info('All mock trades (chronological)');
      } else {
        logger.info(`First mock trades (chronological, limit ${limit})`);
      }
      let cumulative = 0;
      for (const trade of trades) {
        const side = trade.side || 'UNKNOWN';
        const usdcAmount = typeof trade.usdcAmount === 'number' ? trade.usdcAmount : 0;
        const delta = side === 'BUY' ? -usdcAmount : side === 'SELL' || side === 'REDEEM' ? usdcAmount : 0;
        cumulative += delta;
        const pct = (task.initialFinance ?? 0) > 0
          ? (cumulative / (task.initialFinance ?? 0)) * 100
          : null;
        const label = trade.title || trade.slug || trade.conditionId || 'unknown';
        logger.info(
          `  ${formatIso(trade.executedAt)} | ${side.padEnd(6)} | ${formatUsd(usdcAmount).padEnd(10)} | ` +
          `delta ${formatUsd(delta).padEnd(10)} | cum ${formatUsd(cumulative).padEnd(10)} | ` +
          `cumPct ${formatPct(pct)} | ${label}`
        );
      }
    }

    logger.info('Trade totals');
    logger.info(`  BUY: ${buyTotals.count} trades, ${formatUsd(buyTotals.totalUsd)}`);
    logger.info(`  SELL: ${sellTotals.count} trades, ${formatUsd(sellTotals.totalUsd)}`);
    logger.info(`  REDEEM: ${redeemTotals.count} trades, ${formatUsd(redeemTotals.totalUsd)}`);
    if (unknownTotals.count > 0) {
      logger.info(`  UNKNOWN: ${unknownTotals.count} trades, ${formatUsd(unknownTotals.totalUsd)}`);
    }
    if (otherTotals.count > 0) {
      logger.info(`  OTHER: ${otherTotals.count} trades, ${formatUsd(otherTotals.totalUsd)}`);
    }
    logger.info(`  netCashFlow: ${formatSignedUsd(netCashFlow)}`);
    logger.info(`  expectedBalance: ${formatUsd(expectedBalance)}`);
    logger.info(`  balanceGap: ${formatSignedUsd(balanceGap)}`);

    const positions = await MyPosition.find({ taskId }).lean();
    let totalPositionValue = 0;
    let totalCostBasis = 0;

    for (const pos of positions) {
      const size = typeof pos.size === 'number' ? pos.size : 0;
      if (size <= 0) continue;
      const currentValue = Number.isFinite(pos.currentValue)
        ? pos.currentValue
        : size * ((pos.curPrice as number) || (pos.avgPrice as number) || 0);
      const costBasis = Number.isFinite(pos.totalBought) && pos.totalBought > 0
        ? pos.totalBought
        : Number.isFinite(pos.initialValue) && pos.initialValue > 0
          ? pos.initialValue
          : ((pos.avgPrice as number) || 0) * size;
      totalPositionValue += currentValue;
      totalCostBasis += costBasis;
    }

    const equity = (task.currentBalance ?? 0) + totalPositionValue;
    const totalPnl = equity - (task.initialFinance ?? 0);
    const pnlPct = (task.initialFinance ?? 0) > 0
      ? (totalPnl / (task.initialFinance ?? 0)) * 100
      : null;

    logger.info('Equity');
    logger.info(`  totalPositionValue: ${formatUsd(totalPositionValue)}`);
    logger.info(`  totalCostBasis: ${formatUsd(totalCostBasis)}`);
    logger.info(`  equity: ${formatUsd(equity)}`);
    logger.info(`  totalPnl: ${formatUsd(totalPnl)} (${formatPct(pnlPct)})`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  logger.error({ err: error }, 'Analyze failed');
  process.exit(1);
});
