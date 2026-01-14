import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from './redis.js';
import { CopyTask } from '../types/task.js';
import { scheduleTaskJob, removeTaskJob } from './queue.js';

const TASKS_KEY = 'copy-polymarket:tasks';

/**
 * Generates a unique ID using UUID v4, ensuring it doesn't already exist in Redis.
 */
async function generateUniqueId(): Promise<string> {
  const redis = await getRedisClient();
  let id: string;
  do {
    id = uuidv4();
  } while (await redis.hExists(TASKS_KEY, id));

  return id;
}

export async function addTask(taskData: Omit<CopyTask, 'id' | 'status' | 'createdAt'>): Promise<CopyTask> {
  const redis = await getRedisClient();
  const id = await generateUniqueId();
  const task: CopyTask = {
    ...taskData,
    id,
    status: 'running',
    createdAt: Date.now(),
  };

  await redis.hSet(TASKS_KEY, task.id, JSON.stringify(task));
  
  // Schedule the repeating job for this task
  await scheduleTaskJob(task.id);
  
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
  
export async function getTask(id: string): Promise<CopyTask | null> {
  const redis = await getRedisClient();
  const taskStr = await redis.hGet(TASKS_KEY, id);
  if (!taskStr) return null;
  return JSON.parse(taskStr) as CopyTask;
}

export async function stopTask(id: string): Promise<boolean> {
  const redis = await getRedisClient();
  const taskStr = await redis.hGet(TASKS_KEY, id);
  if (!taskStr) return false;

  const task = JSON.parse(taskStr) as CopyTask;
  task.status = 'stopped';
  await redis.hSet(TASKS_KEY, id, JSON.stringify(task));
  
  // Remove the repeating job
  await removeTaskJob(id);
  
  return true;
}

export async function removeTask(id?: string): Promise<number> {
  const redis = await getRedisClient();
  
  if (id) {
    // Remove specific task job
    await removeTaskJob(id);
    return await redis.hDel(TASKS_KEY, id);
  } else {
    // Remove all task jobs
    // We need to list them first to get IDs
    const allTasksStr = await redis.hGetAll(TASKS_KEY);
    const tasks = Object.values(allTasksStr).map(t => JSON.parse(t) as CopyTask);
    
    for (const task of tasks) {
      await removeTaskJob(task.id);
    }
    
    const count = await redis.del(TASKS_KEY);
    return count;
  }
}

