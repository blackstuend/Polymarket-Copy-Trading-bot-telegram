import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client';
import { Wallet, ethers, Contract } from 'ethers';
import { logger } from '../utils/logger.js';
import { getTradingClobClient } from '../services/polymarket.js';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.join(process.cwd(), '.env') });

const LIVE_RETRY_LIMIT = 3;
const MIN_ORDER_SIZE_TOKENS = 1.0;

// Constants from reference script
const REF_CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const REF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const REF_NEG_RISK_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ERC1155_ABI = [
    'function isApprovedForAll(address account, address operator) public view returns (bool)',
    'function setApprovalForAll(address operator, bool approved) public',
];

interface LiveSellResult {
    totalSoldTokens: number;
    totalReceivedUsd: number;
    abortedDueToFunds: boolean;
    retryCount: number;
}

const extractOrderError = (resp: unknown): string | undefined => {
    if (!resp || typeof resp !== 'object') return undefined;
    const obj = resp as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.message === 'string') return obj.message;
    if (obj.error && typeof obj.error === 'object') {
        const errObj = obj.error as Record<string, unknown>;
        if (typeof errObj.message === 'string') return errObj.message;
    }
    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message?: string): boolean => {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return (
        normalized.includes('insufficient') &&
        (normalized.includes('balance') ||
            normalized.includes('allowance') ||
            normalized.includes('funds'))
    );
};

// Update Polymarket internal balance cache
const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        logger.info('🔄 Updating Polymarket balance cache for token...');
        const updateParams = {
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        };

        await clobClient.updateBalanceAllowance(updateParams);
        logger.info('✅ Cache updated successfully');
    } catch (error) {
        logger.warn(`⚠️  Warning: Could not update cache: ${error}`);
    }
};

// Check and approve exchanges (CTF)
const checkAndApproveSales = async (
    wallet: Wallet,
    provider: ethers.JsonRpcProvider
) => {
    logger.info('🔐 Checking allowance for Conditional Tokens...');
    const ctf = new Contract(REF_CTF_ADDRESS, ERC1155_ABI, wallet);

    // Get current gas fees
    const feeData = await provider.getFeeData();
    // Ensure we have a minimum of 40 Gwei for maxPriorityFeePerGas
    const minGasPrice = ethers.parseUnits('40', 'gwei');

    let maxPriorityFee = feeData.maxPriorityFeePerGas || minGasPrice;
    if (maxPriorityFee < minGasPrice) {
        maxPriorityFee = minGasPrice;
    }

    // Add some buffer to maxFeePerGas
    let maxFee = feeData.maxFeePerGas || (maxPriorityFee * 2n);
    if (maxFee < maxPriorityFee) {
        maxFee = maxPriorityFee * 2n;
    }

    const txOptions = {
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: maxPriorityFee,
    };

    logger.info(`⛽ Using gas price: ${ethers.formatUnits(maxPriorityFee, 'gwei')} Gwei`);

    // Check main Exchange
    const isApprovedExchange = await ctf.isApprovedForAll(wallet.address, REF_EXCHANGE_ADDRESS);
    if (!isApprovedExchange) {
        logger.warn('⚠️ Exchange not approved. Sending approval transaction...');
        const tx = await ctf.setApprovalForAll(REF_EXCHANGE_ADDRESS, true, txOptions);
        logger.info(`✅ Transaction sent: ${tx.hash}`);
        await tx.wait();
        logger.info('🎉 Approval confirmed for Exchange!');
    } else {
        logger.info('✅ Exchange already approved.');
    }

    // Check NegRisk Exchange
    const isApprovedNegRisk = await ctf.isApprovedForAll(wallet.address, REF_NEG_RISK_EXCHANGE_ADDRESS);
    if (!isApprovedNegRisk) {
        logger.warn('⚠️ NegRisk Exchange not approved. Sending approval transaction...');
        const tx = await ctf.setApprovalForAll(REF_NEG_RISK_EXCHANGE_ADDRESS, true, txOptions);
        logger.info(`✅ Transaction sent: ${tx.hash}`);
        await tx.wait();
        logger.info('🎉 Approval confirmed for NegRisk Exchange!');
    } else {
        logger.info('✅ NegRisk Exchange already approved.');
    }
};

const executeLiveSellOrders = async (
    clobClient: ClobClient,
    asset: string,
    sellAmount: number,
    logPrefix: string
): Promise<LiveSellResult> => {
    let remaining = sellAmount;
    let retry = 0;
    let abortedDueToFunds = false;
    let totalSoldTokens = 0;
    let totalReceivedUsd = 0;

    // Update cache before selling
    await updatePolymarketCache(clobClient, asset);

    while (remaining > 0 && retry < LIVE_RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(asset);
        if (!orderBook.bids || orderBook.bids.length === 0) {
            logger.warn(`${logPrefix} No bids available in order book`);
            break;
        }

        const maxPriceBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);

        logger.info(`${logPrefix} Best bid: ${maxPriceBid.size} @ $${maxPriceBid.price}`);

        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            logger.info(
                `${logPrefix} Remaining amount (${remaining.toFixed(2)} tokens) below minimum - completing trade`
            );
            break;
        }

        const orderSellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));
        if (orderSellAmount < MIN_ORDER_SIZE_TOKENS) {
            logger.info(
                `${logPrefix} Order amount (${orderSellAmount.toFixed(2)} tokens) below minimum - completing trade`
            );
            break;
        }

        const orderArgs = {
            side: Side.SELL,
            tokenID: asset,
            amount: orderSellAmount,
            price: parseFloat(maxPriceBid.price),
        };

        logger.info(
            `${logPrefix} Creating order: ${orderSellAmount.toFixed(2)} tokens @ $${maxPriceBid.price}`
        );

        try {
            const signedOrder = await clobClient.createMarketOrder(orderArgs);
            // @ts-ignore
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);

            // resp might have success boolean
            if ((resp as any)?.success === true) {
                retry = 0;
                totalSoldTokens += orderArgs.amount;
                totalReceivedUsd += orderArgs.amount * orderArgs.price;
                logger.info(`${logPrefix} Sold ${orderArgs.amount.toFixed(2)} tokens at $${orderArgs.price}`);
                remaining -= orderArgs.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortedDueToFunds = true;
                    logger.warn(
                        `${logPrefix} Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    break;
                }
                retry += 1;
                logger.warn(
                    `${logPrefix} Order failed (attempt ${retry}/${LIVE_RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        } catch (e: any) {
            retry += 1;
            logger.error(`${logPrefix} Error posting order: ${e.message}`);
        }
    }

    return { totalSoldTokens, totalReceivedUsd, abortedDueToFunds, retryCount: retry };
};

const main = async () => {
    const args = process.argv.slice(2);

    // Check args
    if (args.length < 3) {
        console.log(`
Usage: pnpm tsx src/scripts/manualSell.ts <privateKey> <asset> <amount> [proxyWallet]

Parameters:
  privateKey: The private key of the wallet to sell from
  asset: The token ID (asset) to sell
  amount: The amount of tokens to sell
  proxyWallet: (Optional) The Gnosis Safe or proxy address if different from signer
        `);
        process.exit(1);
    }

    const privateKey = args[0];
    const asset = args[1];
    const amountStr = args[2];
    const proxyWallet = args[3];
    const amount = parseFloat(amountStr);

    if (isNaN(amount) || amount <= 0) {
        logger.error("Invalid amount");
        process.exit(1);
    }

    try {
        // Setup provider for approvals
        const rpcUrl = process.env.RPC_URL || 'https://polygon-rpc.com';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new Wallet(privateKey, provider);
        const targetWalletAddress = proxyWallet || wallet.address;

        logger.info(`Initializing sell for signer: ${wallet.address}`);
        if (proxyWallet) {
            logger.info(`Using Proxy Wallet: ${proxyWallet}`);
        }
        logger.info(`Asset: ${asset}`);
        logger.info(`Amount: ${amount}`);

        // 1. Check & Approve Sales (if not using proxy, or if signer needs to approve for safe? 
        // Actually, if using Gnosis Safe, the Safe itself needs to approve. 
        // This script signs as the KEY owner. 
        // If Proxy is used, we might need different logic. 
        // But assuming the user provided script implies the KEY owner approves directly 
        // OR the user is just selling from EOA.
        // If selling from Gnosis Safe, the approval transaction must be proposed/executed by the Safe.
        // The provided checkAndApproveSales uses 'wallet' (signer) to approve. 
        // This only works if the wallet IS the owner of the tokens (EOA).
        // If using Proxy, this approval might be irrelevant for the Proxy's tokens unless the signer is acting on behalf.
        // However, we will include it as requested for EOA flows.)
        if (!proxyWallet) {
            await checkAndApproveSales(wallet, provider);
        } else {
            logger.info("Skipping EOA approval checks as Proxy Wallet is used (approval must be on Smart Contract)");
        }

        // Mock Task for getTradingClobClient
        const mockTask: any = {
            type: 'live',
            privateKey: privateKey,
            myWalletAddress: targetWalletAddress
        };

        const client = await getTradingClobClient(mockTask);

        logger.info(`Starting execution...`);
        const result = await executeLiveSellOrders(client, asset, amount, "[MANUAL-SELL]");

        logger.info("Sell operation completed.");
        logger.info(`Total Sold: ${result.totalSoldTokens}`);
        logger.info(`Total Received USD: ${result.totalReceivedUsd}`);
        logger.info(`Aborted Due To Funds: ${result.abortedDueToFunds}`);

        process.exit(0);
    } catch (error) {
        logger.error(`Error executing sell: ${error}`);
        process.exit(1);
    }
};

main();
