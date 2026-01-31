import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { logger } from '../utils/logger.js';
import { getTradingClobClient } from '../services/polymarket.js';
import dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.join(process.cwd(), '.env') });

const LIVE_RETRY_LIMIT = 3;
const MIN_ORDER_SIZE_TOKENS = 1.0;

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
    }

    return { totalSoldTokens, totalReceivedUsd, abortedDueToFunds, retryCount: retry };
};

const main = async () => {
    const args = process.argv.slice(2);

    // Check args
    if (args.length < 3) {
        console.log(`
Usage: pnpm tsx src/scripts/manualSell.ts <privateKey> <asset> <amount>

Parameters:
  privateKey: The private key of the wallet to sell from
  asset: The token ID (asset) to sell
  amount: The amount of tokens to sell
        `);
        process.exit(1);
    }

    const privateKey = args[0];
    const asset = args[1];
    const amountStr = args[2];
    const amount = parseFloat(amountStr);

    if (isNaN(amount) || amount <= 0) {
        logger.error("Invalid amount");
        process.exit(1);
    }

    try {
        const wallet = new Wallet(privateKey);
        logger.info(`Initializing sell for wallet: ${wallet.address}`);
        logger.info(`Asset: ${asset}`);
        logger.info(`Amount: ${amount}`);

        // Mock Task for getTradingClobClient
        const mockTask: any = {
            type: 'live',
            privateKey: privateKey,
            myWalletAddress: wallet.address
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
