import { fetchData } from '../utils/fetchData.js';

export async function performStartupChecks(): Promise<void> {
  const checks: Record<string, any> = {};

  // Check Polymarket API
  try {
    const testUrl =
      'https://data-api.polymarket.com/positions?user=0x0000000000000000000000000000000000000000';
    await fetchData(testUrl);
    checks.polymarketApi = { status: 'ok', message: 'API responding' };
  } catch (error) {
    checks.polymarketApi = {
      status: 'error',
      message: `API check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const [key, value] of Object.entries(checks)) {
    if (value.status === 'ok') {
      console.log(`✅ ${key} check passed`);
    } else {
      console.error(`❌ ${key} check failed: ${value.message}`);
    }
  }
}
