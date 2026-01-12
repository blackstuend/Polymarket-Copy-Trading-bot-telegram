import { getRedisClient } from './redis.js';
import { CopyTask } from '../types/task.js';

const TASKS_KEY = 'copy-polymarket:tasks';

export async function addTask(taskData: Omit<CopyTask, 'id' | 'status' | 'createdAt'>): Promise<CopyTask> {
  const redis = await getRedisClient();
  const task: CopyTask = {
    ...taskData,
    id: Math.random().toString(36).substring(2, 9), // Simple ID for display
    status: 'running',
    createdAt: Date.now(),
  };

  await redis.hSet(TASKS_KEY, task.id, JSON.stringify(task));
  return task;
}

export async function listTasks(type?: 'live' | 'mock'): Promise<CopyTask[]> {
  const redis = await getRedisClient();
  const allTasksStr = await redis.hGetAll(TASKS_KEY);
  
  const tasks = Object.values(allTasksStr).map(t => JSON.parse(t) as CopyTask);
  
  if (type) {
    return tasks.filter(t => t.type === type);
  }
  return tasks;
}

export async function stopTask(id: string): Promise<boolean> {
  const redis = await getRedisClient();
  const taskStr = await redis.hGet(TASKS_KEY, id);
  if (!taskStr) return false;

  const task = JSON.parse(taskStr) as CopyTask;
  task.status = 'stopped';
  await redis.hSet(TASKS_KEY, id, JSON.stringify(task));
  return true;
}

export async function removeTask(id?: string): Promise<number> {
  const redis = await getRedisClient();
  if (id) {
    return await redis.hDel(TASKS_KEY, id);
  } else {
    // If no ID, maybe remove all? 
    // The user's request /remove was without args, but they also have /stop id.
    // I'll assume /remove removes ALL if no args, or I'll implement it as /remove id.
    // Let's check the request again: "/stop id", "/remove".
    // Usually /remove implies removing the task completely from DB.
    const count = await redis.del(TASKS_KEY);
    return count;
  }
}
