import { Telegraf, Context } from 'telegraf';
import { config } from '../config/index.js';
import { getExampleQueue } from '../services/queue.js';
import { addTask, listTasks, stopTask, removeTask } from '../services/taskService.js';
import { CopyTask } from '../types/task.js';

let bot: Telegraf | null = null;

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

/mock <address> <url> <finance> <max> <min> <duplicate> - Start a mock copy task
/start <address> <url> <finance> <max> <min> <duplicate> - Start a live copy task
/list - List all live tasks
/list\\_mock - List all mock tasks
/stop <id> - Stop a task
/remove <id> - Remove a task (or use /remove all to clear)
/help - Show this help message
/ping - Check bot status
    `;
    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  });

  // Helper to parse task arguments
  const parseTaskArgs = (text: string) => {
    const parts = text.split(/\s+/).slice(1);
    if (parts.length < 6) return null;
    
    const finance = parseFloat(parts[2]);
    const max = parseFloat(parts[3]);
    const min = parseFloat(parts[4]);
    const duplicate = parts[5].toLowerCase() === 'true';

    if (isNaN(finance) || isNaN(max) || isNaN(min)) return null;

    return {
      address: parts[0],
      url: parts[1],
      finance,
      max,
      min,
      duplicate,
    };
  };

  // /mock command
  bot.command('mock', async (ctx) => {
    const args = parseTaskArgs(ctx.message.text);
    if (!args) {
      return ctx.reply('❌ Usage: /mock <address> <url> <finance> <max> <min> <true/false>');
    }
    const task = await addTask({
      type: 'mock',
      address: args.address,
      url: args.url,
      initialFinance: args.finance,
      max: args.max,
      min: args.min,
      duplicate: args.duplicate,
    });
    await ctx.reply(`✅ Mock task created! ID: ${task.id}`);
  });

  // /start command
  bot.command('start', async (ctx) => {
    const args = parseTaskArgs(ctx.message.text);
    if (!args) {
      return ctx.reply(
        '👋 Welcome! I am your Polymarket Copy Trading Bot.\n\n' +
        'Usage: /start <address> <url> <finance> <max> <min> <true/false>\n' +
        'Or type /help for more info.'
      );
    }
    const task = await addTask({
      type: 'live',
      address: args.address,
      url: args.url,
      initialFinance: args.finance,
      max: args.max,
      min: args.min,
      duplicate: args.duplicate,
    });
    await ctx.reply(`🚀 Live task started! ID: ${task.id}`);
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
    const msg = tasks.map((t: CopyTask) => `ID: ${t.id} | ${t.address} | ${t.status}`).join('\n');
    await ctx.reply(`📋 *Mock Tasks*:\n${msg}`, { parse_mode: 'Markdown' });
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
