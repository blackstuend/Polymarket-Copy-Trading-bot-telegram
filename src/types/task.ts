export interface CopyTask {
  id: string;
  type: 'live' | 'mock';
  address: string;
  wallet: string;
  url: string;
  initialFinance: number;
  currentBalance: number;
  fixedAmount: number;
  duplicate: boolean;
  status: 'running' | 'stopped';
  createdAt: number;
  // Live mode config for on-chain operations (redeem, etc.)
  privateKey?: string;
  rpcUrl?: string;
}
