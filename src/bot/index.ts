import { Telegraf, Context } from 'telegraf';
import { config } from '../config/index.js';
import { addTask, listTasks, stopTask, removeTask } from '../services/taskService.js';
import { MyPosition } from '../models/MyPosition.js';
import { mockTradeRecrod } from '../models/mockTradeRecrod.js';
import { CopyTask } from '../types/task.js';
import type { IMyPosition } from '../models/MyPosition.js';
import type { IMockTradeRecrod } from '../models/mockTradeRecrod.js';

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

function computePositionStats(positions: IMyPosition[]): {
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
      console.error(`❌ Telegram Error for ${ctx.updateType}:`, err);
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
    console.log(`📨 Response time: ${ms}ms`);
  });
}

function setupCommands(bot: Telegraf): void {
  // /help command
  bot.command('help', async (ctx) => {
    const helpMessage = `
🤖 *Available Commands*:

/mock <address> <url> <finance> <amount> <duplicate> - Start a mock copy task
/start <address> <url> <finance> <amount> <duplicate> - Start a live copy task
/list - List all live tasks
/list\\_mock - List all mock tasks
/stop <id> - Stop a task
/remove <id> - Remove a task (or use /remove all to clear)
/help - Show this help message
/ping - Check bot status

*Parameters*:
- finance: Initial balance
- amount: Fixed amount per trade
    `;
    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  });

  // Helper to parse task arguments
  const parseTaskArgs = (text: string) => {
    const parts = text.split(/\s+/).slice(1);
    if (parts.length < 5) return null;

    const finance = parseFloat(parts[2]);
    const amount = parseFloat(parts[3]);
    const duplicate = parts[4].toLowerCase() === 'true';

    if (isNaN(finance) || isNaN(amount)) return null;

    return {
      address: parts[0],
      url: parts[1],
      finance,
      amount,
      duplicate,
    };
  };

  // /mock command
  bot.command('mock', async (ctx) => {
    const args = parseTaskArgs(ctx.message.text);
    if (!args) {
      return ctx.reply('❌ Usage: /mock <address> <url> <finance> <amount> <true/false>');
    }
    const task = await addTask({
      type: 'mock',
      address: args.address,
      url: args.url,
      initialFinance: args.finance,
      currentBalance: args.finance,
      fixedAmount: args.amount,
      duplicate: args.duplicate,
    });
    await ctx.reply(`✅ Mock task created! ID: ${task.id}\nFixed amount: $${args.amount}`);
  });

  // /start command
  bot.command('start', async (ctx) => {
    const args = parseTaskArgs(ctx.message.text);
    if (!args) {
      return ctx.reply(
        '👋 Welcome! I am your Polymarket Copy Trading Bot.\n\n' +
        'Usage: /start <address> <url> <finance> <amount> <true/false>\n' +
        'Or type /help for more info.'
      );
    }
    const task = await addTask({
      type: 'live',
      address: args.address,
      url: args.url,
      initialFinance: args.finance,
      currentBalance: args.finance,
      fixedAmount: args.amount,
      duplicate: args.duplicate,
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
      const taskWallet = task.wallet ?? task.address;
      const [positions, recentTrades, realizedAgg] = await Promise.all([
        MyPosition.find({ taskId: task.id, proxyWallet: taskWallet }).exec(),
        mockTradeRecrod
          .find({ taskId: task.id })
          .sort({ executedAt: -1 })
          .limit(5)
          .exec(),
        mockTradeRecrod.aggregate<{ _id: null; total: number }>([
          { $match: { taskId: task.id, realizedPnl: { $ne: null } } },
          { $group: { _id: null, total: { $sum: '$realizedPnl' } } },
        ]),
      ]);

      const realizedPnl = realizedAgg[0]?.total ?? 0;
      const positionStats = computePositionStats(positions);
      const equity = task.currentBalance + positionStats.totalPositionValue;
      const totalPnl = equity - task.initialFinance;
      const pnlPct = task.initialFinance > 0 ? (totalPnl / task.initialFinance) * 100 : null;

      const lastTrade = recentTrades[0];
      const lastTradeLabel = lastTrade
        ? `${formatDateTime(lastTrade.executedAt)} ${lastTrade.side} ` +
          `${lastTrade.title || lastTrade.slug || lastTrade.conditionId || 'unknown'}`
        : 'n/a';

      const lines: string[] = [
        `*Mock Task* ${escapeMarkdown(task.id)}`,
        `ID: \`${escapeMarkdown(task.id)}\``,
        `Address: \`${escapeMarkdown(task.address)}\``,
      ];

      if (task.wallet) {
        lines.push(`Wallet: \`${escapeMarkdown(task.wallet)}\``);
      }

      lines.push(
        `Status: ${escapeMarkdown(task.status)}`,
        `Fixed amount: ${formatUsd(task.fixedAmount)} | Duplicate: ${task.duplicate ? 'true' : 'false'}`,
        `Initial: ${formatUsd(task.initialFinance)} | Balance: ${formatUsd(task.currentBalance)} | Equity: ${formatUsd(equity)}`,
        `PnL: ${formatSignedUsd(totalPnl)} (${formatPct(pnlPct)}) | Realized: ${formatSignedUsd(realizedPnl)} | ` +
          `Unrealized: ${formatSignedUsd(positionStats.unrealizedPnl)}`,
        `Positions: ${positionStats.openPositions} | Exposure: ${formatUsd(positionStats.totalPositionValue)}`,
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
    console.log('Bot stopped');
  }
}
