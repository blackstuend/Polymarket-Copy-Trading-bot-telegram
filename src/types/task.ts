/**
 * Base fields shared by all task types
 */
interface TaskBase {
  id: string;
  address: string;
  url: string;
  fixedAmount: number;
  status: 'running' | 'stopped';
  createdAt: number;
}

/**
 * Mock task for paper trading simulation.
 * All financial fields are required since we track everything in-memory.
 */
export interface MockTask extends TaskBase {
  type: 'mock';
  myWalletAddress?: string;
  initialFinance: number;
  currentBalance: number;
  privateKey?: string;
}

/**
 * Live task for real on-chain trading.
 * Requires privateKey for signing transactions.
 * Financial tracking fields are optional (may be fetched from chain).
 */
export interface LiveTask extends TaskBase {
  type: 'live';
  myWalletAddress: string;
  initialFinance?: number;
  currentBalance?: number;
  privateKey: string;
}

/**
 * Union type for all copy tasks.
 * Use `task.type` to discriminate between MockTask and LiveTask.
 */
export type CopyTask = MockTask | LiveTask;

/**
 * Type guard to check if a task is a MockTask
 */
export function isMockTask(task: CopyTask): task is MockTask {
  return task.type === 'mock';
}

/**
 * Type guard to check if a task is a LiveTask
 */
export function isLiveTask(task: CopyTask): task is LiveTask {
  return task.type === 'live';
}
