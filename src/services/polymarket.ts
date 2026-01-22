import { ClobClient } from '@polymarket/clob-client';
import { config } from '../config/index.js';

let clobClient: ClobClient | null = null;

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
