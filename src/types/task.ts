export interface CopyTask {
  id: string;
  type: 'live' | 'mock';
  address: string;
  url: string;
  initialFinance: number;
  max: number;
  min: number;
  duplicate: boolean;
  status: 'running' | 'stopped';
  createdAt: number;
}
