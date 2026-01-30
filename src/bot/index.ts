import { Telegraf, Context } from 'telegraf';
import { config } from '../config/index.js';
import { addTask, listTasks, stopTask, removeTask } from '../services/taskService.js';
import { MockPosition } from '../models/MockPosition.js';
import { mockTradeRecrod } from '../models/mockTradeRecrod.js';
import { CopyTask } from '../types/task.js';
import type { IMockPosition } from '../models/MockPosition.js';
import type { IMockTradeRecrod } from '../models/mockTradeRecrod.js';
import { logger } from '../utils/logger.js';

let bot: Telegraf | null = null;

function escapeMarkdown(text: string): string {
  return text.replace(/[_*`[\]]/g, '\\$&');
}

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

function formatDateTime(timestampMs: number | undefined): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return 'n/a';
  return new Date(timestampMs).toISOString().replace('T', ' ');
}

function formatTradeLine(trade: IMockTradeRecrod, index: number): string {
  const label = trade.title || trade.slug || trade.conditionId || 'unknown';
  const outcome = trade.outcome ? ` (${trade.outcome})` : '';
  const realized =
    typeof trade.realizedPnl === 'number' ? ` | pnl ${formatSignedUsd(trade.realizedPnl)}` : '';
  const usdcAmount = typeof trade.usdcAmount === 'number' ? trade.usdcAmount : 0;
  const fillPrice = typeof trade.fillPrice === 'number' ? trade.fillPrice : 0;
  const fillSize = typeof trade.fillSize === 'number' ? trade.fillSize : 0;

  return `${index}. ${formatDateTime(trade.executedAt)} ${escapeMarkdown(trade.side)} ` +
    `${escapeMarkdown(label)}${escapeMarkdown(outcome)} | ${formatUsd(usdcAmount)} ` +
    `@${fillPrice.toFixed(4)} | size ${fillSize.toFixed(2)}${realized}`;
}

function formatPositionLine(position: IMockPosition, index: number): string {
  const label = position.title || position.slug || position.conditionId || 'unknown';
  const outcome = position.outcome ? ` (${position.outcome})` : '';
  const size = Number.isFinite(position.size) ? position.size : 0;
  const avgPrice = Number.isFinite(position.avgPrice) ? position.avgPrice : 0;
  const curPrice = Number.isFinite(position.curPrice)
    ? position.curPrice
    : avgPrice;
  const currentValue = Number.isFinite(position.currentValue)
    ? position.currentValue
    : size * curPrice;
  const cashPnl = Number.isFinite(position.cashPnl) ? position.cashPnl : 0;
  const percentPnl = Number.isFinite(position.percentPnl) ? position.percentPnl : null;
  const pnlEmoji = cashPnl >= 0 ? '🟢' : '🔴';

  return `${index}. ${escapeMarkdown(label)}${escapeMarkdown(outcome)} | ` +
    `size ${size.toFixed(2)} | buy ${avgPrice.toFixed(4)} | cur ${curPrice.toFixed(4)} | ` +
    `value ${formatUsd(currentValue)} | ` +
    `${pnlEmoji} uPnL ${formatSignedUsd(cashPnl)} (${formatPct(percentPnl)})`;
}

function getPositionCostBasis(position: IMockPosition, size: number): number {
  if (Number.isFinite(position.totalBought) && position.totalBought > 0) {
    return position.totalBought;
  }
  if (Number.isFinite(position.initialValue) && position.initialValue > 0) {
    return position.initialValue;
  }
  const avgPrice = Number.isFinite(position.avgPrice) ? position.avgPrice : 0;
  return avgPrice * size;
}

async function getOrderBookPriceMap(positions: IMockPosition[]): Promise<Map<string, number>> {
  const assets = Array.from(
    new Set(positions.map((pos) => pos.asset).filter((asset) => typeof asset === 'string' && asset))
  );
  if (assets.length === 0) return new Map();

  const baseUrl = config.polymarket.clobHttpUrl;
  const results = await Promise.all(
    assets.map(async (asset) => {
      try {
        const url = `${baseUrl}/price?token_id=${asset}&side=sell`;
        const res = await fetch(url);
        if (!res.ok) {
          logger.error(`[list_mock] Price API returned ${res.status} for ${asset}`);
          return [asset, undefined] as const;
        }
        const data = (await res.json()) as { price?: string };
        const price = data.price ? parseFloat(data.price) : undefined;
        return [asset, price] as const;
      } catch (error) {
        logger.error({ err: error }, `[list_mock] Failed to fetch price for ${asset}`);
        return [asset, undefined] as const;
      }
    })
  );

  const priceMap = new Map<string, number>();
  for (const [asset, price] of results) {
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      priceMap.set(asset, price);
    }
  }
  return priceMap;
}

function applyOrderBookPrices(
  positions: IMockPosition[],
  priceMap: Map<string, number>
): IMockPosition[] {
  if (priceMap.size === 0) return positions;

  return positions.map((position) => {
    const price = priceMap.get(position.asset);
    if (!price) return position;

    const size = Number.isFinite(position.size) ? position.size : 0;
    const currentValue = size * price;
    const costBasis = getPositionCostBasis(position, size);
    const cashPnl = currentValue - costBasis;
    const percentPnl = costBasis > 0 ? (cashPnl / costBasis) * 100 : null;
    const base =
      typeof (position as IMockPosition & { toObject?: () => IMockPosition }).toObject === 'function'
        ? (position as IMockPosition & { toObject?: () => IMockPosition }).toObject()
        : position;

    return {
      ...base,
      curPrice: price,
      currentValue,
      cashPnl,
      percentPnl,
    } as IMockPosition;
  });
}

function computePositionStats(positions: IMockPosition[]): {
  openPositions: number;
  totalPositionValue: number;
  totalCostBasis: number;
  unrealizedPnl: number;
} {
  let openPositions = 0;
  let totalPositionValue = 0;
  let totalCostBasis = 0;

  for (const pos of positions) {
    const size = typeof pos.size === 'number' ? pos.size : 0;
    if (size <= 0) continue;
    openPositions += 1;

    const currentValue = Number.isFinite(pos.currentValue)
      ? pos.currentValue
      : size * (pos.curPrice || pos.avgPrice || 0);
    const costBasis = Number.isFinite(pos.totalBought) && pos.totalBought > 0
      ? pos.totalBought
      : Number.isFinite(pos.initialValue) && pos.initialValue > 0
        ? pos.initialValue
        : (pos.avgPrice || 0) * size;

    totalPositionValue += currentValue;
    totalCostBasis += costBasis;
  }

  return {
    openPositions,
    totalPositionValue,
    totalCostBasis,
    unrealizedPnl: totalPositionValue - totalCostBasis,
  };
}

export function createBot(): Telegraf {
  if (!bot) {
    bot = new Telegraf(config.telegram.botToken);
    setupCommands(bot);
    setupMiddleware(bot);

    // Global error handler
    bot.catch((err, ctx) => {
      logger.error({ err }, `❌ Telegram Error for ${ctx.updateType}`);
    });
  }
  return bot;
}

function setupMiddleware(bot: Telegraf): void {
  // Log all incoming messages
  bot.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    logger.info(`📨 Response time: ${ms}ms`);
  });
}

function setupCommands(bot: Telegraf): void {
  // /help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
🤖 *Available Commands*:

/mock <address> <url> <finance> <amount> - Start a mock copy task
/start <address> <url> <amount> <myWalletAddress> <privateKey> - Start a live copy task
/list - List all live tasks
/list\\_mock - List all mock tasks
/stop <id> - Stop a task
/remove <id> - Remove a task (or use /remove all to clear)
/help - Show this help message
/ping - Check bot status

*Parameters*:
- finance: Initial balance (mock only)
- amount: Fixed amount per trade
- myWalletAddress: Your wallet address used for live trading
- privateKey: Private key for live trading (do not share publicly)
    `;
    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  });

  // Helper to parse mock task arguments
  const parseMockArgs = (text: string) => {
    const parts = text.split(/\s+/).slice(1);
    if (parts.length < 4) return null;

    const finance = parseFloat(parts[2]);
    const amount = parseFloat(parts[3]);

    if (isNaN(finance) || isNaN(amount)) return null;

    return {
      address: parts[0],
      url: parts[1],
      finance,
      amount,
    };
  };

  // Helper to parse live task arguments
  const parseLiveArgs = (text: string) => {
    const parts = text.split(/\s+/).slice(1);
    if (parts.length < 5) return null;

    const amount = parseFloat(parts[2]);
    if (isNaN(amount)) return null;

    return {
      address: parts[0],
      url: parts[1],
      amount,
      myWalletAddress: parts[3],
      privateKey: parts[4],
    };
  };

  // /mock command
  bot.command('mock', async (ctx) => {
    const args = parseMockArgs(ctx.message.text);
    if (!args) {
      return ctx.reply('❌ Usage: /mock <address> <url> <finance> <amount>');
    }
    const task = await addTask({
      type: 'mock',
      address: args.address,
      url: args.url,
      initialFinance: args.finance,
      currentBalance: args.finance,
      fixedAmount: args.amount,
    });
    await ctx.reply(`✅ Mock task created! ID: ${task.id}\nFixed amount: $${args.amount}`);
  });

  // /start command
  bot.command('start', async (ctx) => {
    const args = parseLiveArgs(ctx.message.text);
    if (!args) {
      return ctx.reply(
        '👋 Welcome! I am your Polymarket Copy Trading Bot.\n\n' +
        'Usage: /start <address> <url> <amount> <myWalletAddress> <privateKey>\n' +
        'Or type /help for more info.'
      );
    }
    const task = await addTask({
      type: 'live',
      address: args.address,
      url: args.url,
      fixedAmount: args.amount,
      myWalletAddress: args.myWalletAddress,
      privateKey: args.privateKey,
    });
    await ctx.reply(`🚀 Live task started! ID: ${task.id}\nFixed amount: $${args.amount}`);
  });

  // /list command
  bot.command('list', async (ctx) => {
    const tasks = await listTasks('live');
    if (tasks.length === 0) return ctx.reply('No live tasks running.');
    const msg = tasks.map((t: CopyTask) => `ID: ${t.id} | ${t.address} | ${t.status}`).join('\n');
    await ctx.reply(`📋 *Live Tasks*:\n${msg}`, { parse_mode: 'Markdown' });
  });

  // /list_mock command
  bot.command('list_mock', async (ctx) => {
    const tasks = await listTasks('mock');
    if (tasks.length === 0) return ctx.reply('No mock tasks running.');
    await ctx.reply(`Mock tasks: ${tasks.length}`);

    for (const task of tasks) {
      const [positions, recentTrades, realizedAgg] = await Promise.all([
        MockPosition.find({ taskId: task.id }).exec(),
        mockTradeRecrod
          .find({ taskId: task.id })
          .sort({ executedAt: -1 })
          .limit(5)
          .exec(),
        mockTradeRecrod.aggregate<{ _id: null; total: number }>([
          { $match: { taskId: task.id, realizedPnl: { $type: 'number' } } },
          { $group: { _id: null, total: { $sum: '$realizedPnl' } } },
        ]),
      ]);

      const realizedPnl = realizedAgg[0]?.total ?? 0;
      const priceMap = await getOrderBookPriceMap(positions);
      const pricedPositions = applyOrderBookPrices(positions, priceMap);
      const positionStats = computePositionStats(pricedPositions);
      const currentBalance = task.currentBalance ?? 0;
      const initialFinance = task.initialFinance ?? 0;
      const equity = currentBalance + positionStats.totalPositionValue;
      const totalPnl = equity - initialFinance;
      const pnlPct = initialFinance > 0 ? (totalPnl / initialFinance) * 100 : null;

      const lastTrade = recentTrades[0];
      const lastTradeLabel = lastTrade
        ? `${formatDateTime(lastTrade.executedAt)} ${lastTrade.side} ` +
          `${lastTrade.title || lastTrade.slug || lastTrade.conditionId || 'unknown'}`
        : 'n/a';

      const openPositions = pricedPositions.filter((pos) => (pos.size ?? 0) > 0);
      const sortedPositions = [...openPositions].sort((a, b) => {
        const aValue = Number.isFinite(a.currentValue)
          ? a.currentValue
          : (a.size || 0) * (a.curPrice || a.avgPrice || 0);
        const bValue = Number.isFinite(b.currentValue)
          ? b.currentValue
          : (b.size || 0) * (b.curPrice || b.avgPrice || 0);
        return bValue - aValue;
      });
      const topPositions = sortedPositions.slice(0, 5);

      const lines: string[] = [
        `*Mock Task* ${escapeMarkdown(task.id)}`,
        `ID: \`${escapeMarkdown(task.id)}\``,
        `Address: \`${escapeMarkdown(task.address)}\``,
        `Profile: ${task.url}`,
      ];

      lines.push(
        `Wallet: \`${escapeMarkdown(task.myWalletAddress || '')}\``,
        `Status: ${escapeMarkdown(task.status)}`,
        `Fixed amount: ${formatUsd(task.fixedAmount)}`,
        `Initial: ${formatUsd(initialFinance)} | Balance: ${formatUsd(currentBalance)} | Equity: ${formatUsd(equity)}`,
        `PnL: ${formatSignedUsd(totalPnl)} (${formatPct(pnlPct)}) | Realized: ${formatSignedUsd(realizedPnl)} | ` +
          `Unrealized: ${formatSignedUsd(positionStats.unrealizedPnl)}`,
        `Positions: ${positionStats.openPositions} | Exposure: ${formatUsd(positionStats.totalPositionValue)}`,
        'Open positions:',
      );

      if (topPositions.length === 0) {
        lines.push('- none');
      } else {
        topPositions.forEach((pos: IMockPosition, index: number) => {
          lines.push(`- ${formatPositionLine(pos, index + 1)}`);
        });
        if (openPositions.length > topPositions.length) {
          lines.push(`- ... and ${openPositions.length - topPositions.length} more`);
        }
      }

      lines.push(
        `Last trade: ${escapeMarkdown(lastTradeLabel)}`,
        'Recent trades:',
      );

      if (recentTrades.length === 0) {
        lines.push('- none');
      } else {
        recentTrades.forEach((trade: IMockTradeRecrod, index: number) => {
          lines.push(`- ${formatTradeLine(trade, index + 1)}`);
        });
      }

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    }
  });

  // /stop command
  bot.command('stop', async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Please provide a task ID: /stop <id>');
    const success = await stopTask(id);
    if (success) {
      await ctx.reply(`🛑 Task ${id} stopped.`);
    } else {
      await ctx.reply(`❌ Task ${id} not found.`);
    }
  });

  // /remove command
  bot.command('remove', async (ctx) => {
    const id = ctx.message.text.split(/\s+/)[1];
    
    if (id === 'all') {
      await removeTask();
      return ctx.reply('🗑️ All tasks removed.');
    }

    if (id) {
      const count = await removeTask(id);
      if (count > 0) {
        await ctx.reply(`🗑️ Task ${id} removed.`);
      } else {
        await ctx.reply(`❌ Task ${id} not found.`);
      }
    } else {
      // If no ID, remove the most recent one
      const tasks = await listTasks();
      if (tasks.length === 0) return ctx.reply('No tasks to remove.');
      
      const latestTask = tasks.sort((a, b) => b.createdAt - a.createdAt)[0];
      await removeTask(latestTask.id);
      await ctx.reply(`🗑️ Removed latest task: ${latestTask.id} (${latestTask.address})`);
    }
  });

  // /ping command
  bot.command('ping', async (ctx) => {
    await ctx.reply('🏓 Pong!');
  });

  // Handle text messages (if needed)
  // bot.on('text', async (ctx) => { ... });
}

export function getBot(): Telegraf | null {
  return bot;
}

export async function stopBot(): Promise<void> {
  if (bot) {
    bot.stop('SIGTERM');
    bot = null;
    logger.info('Bot stopped');
  }
}
