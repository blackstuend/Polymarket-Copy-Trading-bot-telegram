import 'dotenv/config';
import { getRedisClient, closeRedisConnection } from '../services/redis.js';

const LOCK_PREFIX = 'copy-polymarket:task-lock:';
const SCAN_COUNT = 200;

async function clearTaskLocks(): Promise<void> {
  const redis = await getRedisClient();
  const pattern = `${LOCK_PREFIX}*`;
  let cursor = '0';
  let totalDeleted = 0;

  do {
    const scanReply = await redis.scan(cursor, {
      MATCH: pattern,
      COUNT: SCAN_COUNT,
    });
    const nextCursor = Array.isArray(scanReply) ? scanReply[0] : scanReply.cursor;
    const keys = Array.isArray(scanReply) ? scanReply[1] : scanReply.keys;

    if (keys.length > 0) {
      const deleted = await redis.del(keys);
      totalDeleted += deleted;
      console.log(`Deleted ${deleted} lock(s) in this batch`);
    }

    cursor = nextCursor;
  } while (cursor !== '0');

  console.log(`Done. Deleted ${totalDeleted} lock(s) total.`);
  await closeRedisConnection();
}

clearTaskLocks().catch((error) => {
  console.error('Failed to clear task locks:', error);
  process.exitCode = 1;
});
