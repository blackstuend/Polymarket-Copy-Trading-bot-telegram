import { randomUUID } from 'crypto';
import { getRedisClient } from './redis.js';

const TASK_LOCK_PREFIX = 'copy-polymarket:task-lock:';
const TASK_LOCK_TTL_MS = 10 * 60 * 1000;
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

function getLockKey(taskId: string): string {
  return `${TASK_LOCK_PREFIX}${taskId}`;
}

export async function acquireTaskLock(taskId: string, ttlMs: number = TASK_LOCK_TTL_MS): Promise<string | null> {
  const redis = await getRedisClient();
  const token = randomUUID();
  const lockKey = getLockKey(taskId);
  const result = await redis.set(lockKey, token, { NX: true, PX: ttlMs });
  return result ? token : null;
}

export async function releaseTaskLock(taskId: string, token: string): Promise<void> {
  const redis = await getRedisClient();
  const lockKey = getLockKey(taskId);
  await redis.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [token] });
}

export async function withTaskLock(taskId: string, fn: () => Promise<void>): Promise<boolean> {
  const token = await acquireTaskLock(taskId);
  if (!token) {
    return false;
  }

  try {
    await fn();
  } finally {
    try {
      await releaseTaskLock(taskId, token);
    } catch (error) {
      console.error(`❌ Error releasing lock for task ${taskId}:`, error);
    }
  }

  return true;
}
