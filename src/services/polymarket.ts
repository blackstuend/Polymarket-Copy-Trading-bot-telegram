import { ClobClient } from '@polymarket/clob-client';

// Define SignatureType locally as it's not exported by the client package
const SignatureType = {
  EOA: 0,
  POLY_GNOSIS_SAFE: 1,
  POLY_PROXY: 2
};
import { Wallet as V5Wallet } from '@ethersproject/wallet';
import { ethers, Contract } from 'ethers';
import { config } from '../config/index.js';
import { CopyTask } from '../types/task.js';
import { logger } from '../utils/logger.js';
import { AssetType } from '@polymarket/clob-client';

const REF_CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const REF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const REF_NEG_RISK_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ERC1155_ABI = [
  'function isApprovedForAll(address account, address operator) public view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) public',
];

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
/**
 * Check and approve exchanges (CTF) for a given wallet
 */
const checkAndApproveSales = async (
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider
) => {
  try {
    logger.info(`[LIVE] Checking allowance for Conditional Tokens (${wallet.address})...`);
    // Connect wallet to provider if not already
    const connectedWallet = wallet.connect(provider);
    const ctf = new Contract(REF_CTF_ADDRESS, ERC1155_ABI, connectedWallet);

    // Get current gas fees
    const feeData = await provider.getFeeData();
    const minGasPrice = ethers.parseUnits('40', 'gwei');

    let maxPriorityFee = feeData.maxPriorityFeePerGas || minGasPrice;
    if (maxPriorityFee < minGasPrice) {
      maxPriorityFee = minGasPrice;
    }

    let maxFee = feeData.maxFeePerGas || (maxPriorityFee * 2n);
    if (maxFee < maxPriorityFee) {
      maxFee = maxPriorityFee * 2n;
    }

    const txOptions = {
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPriorityFee,
    };

    // Check main Exchange
    const isApprovedExchange = await ctf.isApprovedForAll(wallet.address, REF_EXCHANGE_ADDRESS);
    if (!isApprovedExchange) {
      logger.warn('[LIVE] Exchange not approved. Sending approval transaction...');
      const tx = await ctf.setApprovalForAll(REF_EXCHANGE_ADDRESS, true, txOptions);
      logger.info(`[LIVE] Approval TX sent: ${tx.hash}`);
      await tx.wait();
      logger.info('[LIVE] Approval confirmed for Exchange!');
    }

    // Check NegRisk Exchange
    const isApprovedNegRisk = await ctf.isApprovedForAll(wallet.address, REF_NEG_RISK_EXCHANGE_ADDRESS);
    if (!isApprovedNegRisk) {
      logger.warn('[LIVE] NegRisk Exchange not approved. Sending approval transaction...');
      const tx = await ctf.setApprovalForAll(REF_NEG_RISK_EXCHANGE_ADDRESS, true, txOptions);
      logger.info(`[LIVE] Approval TX sent: ${tx.hash}`);
      await tx.wait();
      logger.info('[LIVE] Approval confirmed for NegRisk Exchange!');
    }
  } catch (error) {
    logger.error(`[LIVE] Error checking/approving tokens: ${error}`);
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
      const { clobHttpUrl, chainId, rpcUrl } = config.polymarket;
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const signerV6 = new ethers.Wallet(task.privateKey, provider);
      const signerV5 = new V5Wallet(task.privateKey);

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
        signerV5,
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

      const client = new ClobClient(clobHttpUrl, chainId, signerV5, creds, signatureType, funderAddress);

      // Perform checks and approvals ONLY for EOA (Signer)
      // If it's a Gnosis Safe, the Safe itself must approve, not the signer key.
      if (!isProxySafe) {
        await checkAndApproveSales(signerV6, provider);

        // Update balance allowance cache
        try {
          // Update cache for a dummy token or all? 
          // The client.updateBalanceAllowance usually takes a token_id. 
          // If we don't have a specific token yet, we might skip this or do it per-trade.
          // However, clob-client might have a method to refresh generic allowance?
          // Checking docs/previous code: updateBalanceAllowance({ asset_type, token_id })
          // We can't easily guess which token to update here without context.
          // But we CAN ensure the Exchange is approved above.

          // To be safe, we might just rely on checkAndApproveSales for the global exchange approval.
          // Specific token cache updates might best be done when trading that token.
          // BUT, user asked to "check if licensed" (approved) at creation.
        } catch (e) {
          logger.warn(`[LIVE] Failed to update balance allowance cache: ${e}`);
        }
      }

      return client;
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
