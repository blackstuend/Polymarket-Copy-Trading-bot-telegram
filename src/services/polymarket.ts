import { ClobClient } from '@polymarket/clob-client';

// Define SignatureType locally as it's not exported by the client package
const SignatureType = {
  EOA: 0,
  POLY_GNOSIS_SAFE: 1,
  POLY_PROXY: 2
};
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



/**
 * Create or return a cached authenticated CLOB client for live trading.
 */
/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
  try {
    const provider = new ethers.JsonRpcProvider(config.polymarket.rpcUrl);
    const code = await provider.getCode(address);
    // If code is not "0x", then it's a contract (likely Gnosis Safe)
    return code !== '0x';
  } catch (error) {
    logger.error(`Error checking wallet type: ${error}`);
    return false;
  }
};

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
      const { clobHttpUrl, chainId } = config.polymarket;
      const signer = new Wallet(task.privateKey);

      // Detect if the proxy wallet is a Gnosis Safe or EOA
      const isProxySafe = await isGnosisSafe(task.myWalletAddress);
      const signatureType = isProxySafe ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
      const funderAddress = isProxySafe ? task.myWalletAddress : undefined;

      logger.info(
        `[LIVE] Wallet type detected: ${isProxySafe ? 'Gnosis Safe' : 'EOA (Externally Owned Account)'}`
      );

      // Initial client for API key creation
      const authClient = new ClobClient(
        clobHttpUrl,
        chainId,
        signer,
        undefined,
        signatureType,
        funderAddress
      );

      // Suppress console output during API key creation
      const originalConsoleLog = console.log;
      const originalConsoleError = console.error;
      console.log = function () { };
      console.error = function () { };

      let creds;
      try {
        creds = await authClient.createApiKey();
        if (!creds.key) {
          creds = await authClient.deriveApiKey();
        }
      } finally {
        // Restore console functions
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
      }

      logger.info(
        `[LIVE] Authenticated CLOB client ready (funder ${funderAddress ? funderAddress.slice(0, 6) + '...' + funderAddress.slice(-4) : 'signer'}, signatureType ${signatureType})`
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
