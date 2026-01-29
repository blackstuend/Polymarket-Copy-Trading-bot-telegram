import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { CopyTask } from '../types/task.js';
import { logger } from '../utils/logger.js';

let clobClient: ClobClient | null = null;
const tradingClients = new Map<string, Promise<ClobClient>>();

/**
 * Create a read-only Polymarket CLOB client (no wallet required)
 * Used for fetching market data, orderbooks, etc.
 */
export function createReadOnlyClobClient(): ClobClient {
  const { clobHttpUrl, chainId } = config.polymarket;

  // Create client without wallet for read-only operations
  const client = new ClobClient(clobHttpUrl, chainId);

  return client;
}

export function initClobClient(): ClobClient {
  if (!clobClient) {
    clobClient = createReadOnlyClobClient();
  }
  return clobClient;
}

export function getClobClient(): ClobClient {
  if (!clobClient) {
    throw new Error('CLOB client not initialized. Call initClobClient() during startup.');
  }
  return clobClient;
}

function resolveFunderAddress(taskWallet: string | undefined, signerAddress: string): string {
  if (taskWallet && ethers.isAddress(taskWallet)) {
    if (taskWallet.toLowerCase() === signerAddress.toLowerCase()) {
      return taskWallet;
    }
    logger.warn(
      `[LIVE] Task myWalletAddress ${taskWallet.slice(0, 6)}...${taskWallet.slice(-4)} ` +
        `does not match signer ${signerAddress.slice(0, 6)}...${signerAddress.slice(-4)}; ` +
        `using signer address as funder`
    );
  }
  return signerAddress;
}

/**
 * Create or return a cached authenticated CLOB client for live trading.
 */
export async function getTradingClobClient(
  task: Extract<CopyTask, { type: 'live' }>
): Promise<ClobClient> {
  if (!task.privateKey) {
    throw new Error('Missing privateKey for live trading');
  }

  const cacheKey = task.privateKey;
  let cached = tradingClients.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const { clobHttpUrl, chainId, signatureType } = config.polymarket;
      const signer = new Wallet(task.privateKey);
      const funderAddress = resolveFunderAddress(task.myWalletAddress, signer.address);

      const authClient = new ClobClient(clobHttpUrl, chainId, signer);
      const creds = await authClient.createOrDeriveApiKey();

      logger.info(
        `[LIVE] Authenticated CLOB client ready (funder ${funderAddress.slice(0, 6)}...${funderAddress.slice(-4)}, signatureType ${signatureType})`
      );

      return new ClobClient(clobHttpUrl, chainId, signer, creds, signatureType, funderAddress);
    })();
    tradingClients.set(cacheKey, cached);
  }

  return cached;
}

/**
 * Check if the CLOB API is reachable (basic health check without authentication)
 */
export async function checkClobConnection(): Promise<{
  status: 'ok' | 'error';
  message: string;
}> {
  try {
    const { clobHttpUrl } = config.polymarket;

    // Simple HTTP check to the CLOB API without authentication
    const response = await fetch(`${clobHttpUrl}/time`);

    if (response.ok) {
      const data = await response.text();
      return {
        status: 'ok',
        message: `CLOB API responding (server time: ${data})`,
      };
    }

    return {
      status: 'error',
      message: `CLOB API returned status ${response.status}`,
    };
  } catch (error) {
    return {
      status: 'error',
      message: `CLOB connection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
