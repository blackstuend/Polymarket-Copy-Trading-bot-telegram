import { fetchData } from '../utils/fetchData.js';
import { checkClobConnection } from './polymarket.js';
import { logger } from '../utils/logger.js';

export async function performStartupChecks(): Promise<void> {
  const checks: Record<string, any> = {};

  // Check Polymarket Data API
  try {
    const testUrl =
      'https://data-api.polymarket.com/positions?user=0x0000000000000000000000000000000000000000';
    await fetchData(testUrl);
    checks.polymarketDataApi = { status: 'ok', message: 'Data API responding' };
  } catch (error) {
    checks.polymarketDataApi = {
      status: 'error',
      message: `Data API check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Check Polymarket CLOB API connection (basic connectivity check)
  try {
    const clobCheck = await checkClobConnection();
    checks.polymarketClobApi = clobCheck;
  } catch (error) {
    checks.polymarketClobApi = {
      status: 'error',
      message: `CLOB API check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const [key, value] of Object.entries(checks)) {
    if (value.status === 'ok') {
      logger.info(`✅ ${key} check passed`);
    } else {
      logger.error(`❌ ${key} check failed: ${value.message}`);
    }
  }

  // Throw error if CLOB API is not working (critical for trading)
  if (checks.polymarketClobApi?.status === 'error') {
    throw new Error(`Polymarket CLOB API check failed: ${checks.polymarketClobApi.message}`);
  }
}

