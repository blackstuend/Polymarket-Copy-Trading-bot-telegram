import { UserActivity, IUserActivity } from '../models/UserActivity.js';
import { TradeRecord } from '../models/TradeRecord.js';
import { MockPosition } from '../models/MockPosition.js';
import { fetchData } from '../utils/fetchData.js';
import { CopyTask } from '../types/task.js';
import { PositionData } from '../types/position.js';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { calculateOrderSize } from '../config/copyStrategy.js';
import type { Types } from 'mongoose';
import { logger } from '../utils/logger.js';
import { getClobClient, getTradingClobClient } from './polymarket.js';
import { redeemPosition } from '../utils/redeemPosition.js';
import getMyBalance from '../utils/getMyBalance.js';

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0;
const MIN_ORDER_SIZE_TOKENS = 1.0;
const LIVE_RETRY_LIMIT = 3;

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

interface MockOrderResult {
    success: boolean;
    fillPrice: number;
    fillSize: number;
    usdcAmount: number;
    slippage: number;
    reason?: string;
}

export const persistTradeRecord = async (
    data: {
        taskId: string;
        taskType: 'live' | 'mock';
        side: string;
        proxyWallet: string;
        asset: string;
        conditionId: string;
        outcomeIndex?: number;
        fillPrice: number;
        fillSize: number;
        usdcAmount: number;
        slippage: number;
        costBasisPrice?: number;
        soldCost?: number;
        realizedPnl?: number;
        positionSizeBefore?: number;
        positionSizeAfter?: number;
        sourceActivityId?: Types.ObjectId;
        sourceTransactionHash?: string;
        sourceTimestamp?: number;
        executedAt?: number;
        title?: string;
        slug?: string;
        eventSlug?: string;
        outcome?: string;
        gasUsed?: number;
    }
): Promise<void> => {
    try {
        await TradeRecord.create({
            ...data,
            executedAt: data.executedAt ?? Date.now(),
        });
    } catch (error) {
        logger.error(`[TradeRecord] Failed to persist trade record: ${error}`);
    }
};

// ============================================================================
// Shared Sell Order Utilities
// ============================================================================

interface LiveSellResult {
    totalSoldTokens: number;
    totalReceivedUsd: number;
    abortedDueToFunds: boolean;
    retryCount: number;
}

/**
 * Execute live SELL orders in a loop until all tokens are sold or limits reached.
 * This is the shared logic used by handleLiveSellTrade and forcedClosePosition.
 */
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
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
        if (resp?.success === true) {
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

interface MockSellInput {
    taskId: string;
    asset: string;
    conditionId: string;
    fillSize: number;
    fillPrice: number;
    avgPrice: number;
    positionSize: number;
    totalBought?: number;
    initialValue?: number;
}

interface MockSellResult {
    newSize: number;
    positionSizeAfter: number;
    soldCost: number;
    realizedPnl: number;
}

/**
 * Update MockPosition after a sell operation.
 * This is the shared logic used by handleSellTrade and forcedClosePosition (mock mode).
 */
const updateMockPositionAfterSell = async (
    input: MockSellInput,
    logPrefix: string
): Promise<MockSellResult> => {
    const costBasisPrice = input.avgPrice > 0 ? input.avgPrice : input.fillPrice;
    const soldCost = input.fillSize * costBasisPrice;
    const realizedPnl = input.fillSize * input.fillPrice - soldCost;

    const newSize = input.positionSize - input.fillSize;
    const positionSizeAfter = newSize <= 0.01 ? 0 : newSize;

    if (newSize <= 0.01) {
        await MockPosition.deleteOne({
            taskId: input.taskId,
            asset: input.asset,
            conditionId: input.conditionId,
        });
        logger.info(`${logPrefix} Position closed`);
    } else {
        const newTotalBought = (input.totalBought || input.initialValue || 0) - soldCost;
        await MockPosition.updateOne(
            { taskId: input.taskId, asset: input.asset, conditionId: input.conditionId },
            {
                $set: {
                    size: newSize,
                    totalBought: newTotalBought,
                    currentValue: newSize * input.fillPrice,
                    cashPnl: newSize * input.fillPrice - newTotalBought,
                    percentPnl: newTotalBought > 0 ? ((newSize * input.fillPrice - newTotalBought) / newTotalBought) * 100 : 0,
                    curPrice: input.fillPrice,
                },
                $inc: {
                    realizedPnl: realizedPnl,
                },
            }
        );
        logger.info(`${logPrefix} Position updated, remaining: ${newSize.toFixed(2)} tokens`);
    }

    return { newSize, positionSizeAfter, soldCost, realizedPnl };
};

export const fetchNewTradeData = async (task: CopyTask) => {
    const address = task.address;
    const ONE_HOUR_IN_SECONDS = 60 * 60;
    const timeWindow = task.type === 'live' ? 60 : ONE_HOUR_IN_SECONDS;
    const TOO_OLD_TIMESTAMP = Math.floor(Date.now() / 1000) - timeWindow;

    try {
        // Fetch trade activities from Polymarket API
        const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&start=${TOO_OLD_TIMESTAMP}`;
        const activities = await fetchData(apiUrl);

        if (!Array.isArray(activities) || activities.length === 0) {
            return;
        }

        // Track seen conditionIds (API returns sorted, first one is latest)
        const seenConditions = new Set<string>();

        for (const activity of activities) {
            if (activity.timestamp < TOO_OLD_TIMESTAMP) {
                continue;
            }

            // Check if already in DB for this specific task
            const exists = await UserActivity.findOne({
                transactionHash: activity.transactionHash,
                taskId: task.id
            }).exec();
            if (exists) {
                continue;
            }

            // Duplicate conditionId → mark as processed (only for BUY, each SELL should be processed independently)
            const isDuplicate = activity.side === 'SELL' ? false : seenConditions.has(activity.conditionId);
            seenConditions.add(activity.conditionId);

            const newActivity = new UserActivity({
                proxyWallet: activity.proxyWallet,
                timestamp: activity.timestamp,
                conditionId: activity.conditionId,
                type: activity.type,
                size: activity.size,
                usdcSize: activity.usdcSize,
                transactionHash: activity.transactionHash,
                price: activity.price,
                asset: activity.asset,
                side: activity.side,
                outcomeIndex: activity.outcomeIndex,
                title: activity.title,
                slug: activity.slug,
                icon: activity.icon,
                eventSlug: activity.eventSlug,
                outcome: activity.outcome,
                name: activity.name,
                pseudonym: activity.pseudonym,
                bio: activity.bio,
                profileImage: activity.profileImage,
                profileImageOptimized: activity.profileImageOptimized,
                bot: isDuplicate,
                botExcutedTime: isDuplicate ? 888 : 0,
                taskId: task.id,
            });

            await newActivity.save();
            logger.info(`New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}: ${activity.transactionHash}${isDuplicate ? ' (duplicate, skipped)' : ''}`);
        }
    } catch (error) {
        logger.error(
            `Error fetching data for ${address.slice(0, 6)}...${address.slice(-4)}: ${error}`
        );
        throw error;
    }
};

/**
 * 取得待執行的交易
 * 從資料庫查詢 bot 為 true 且 taskId 匹配的交易記錄
 * @param taskId - 任務 ID
 * @returns 待執行的交易活動列表
 */
export const getPendingTrades = async (taskId: string) => {
    const pendingTrades = await UserActivity.find({
        bot: false,
        taskId: taskId,
    }).exec();

    return pendingTrades;
}


/**
 * Simulate order execution from order book
 * Calculate expected fill price and slippage
 */
const simulateOrderExecution = async (
    clobClient: ClobClient,
    asset: string,
    side: 'BUY' | 'SELL',
    amount: number, // BUY: USD amount, SELL: token quantity
    targetPrice: number,
    orderBookOverride?: {
        bids?: Array<{ price: string; size: string }>;
        asks?: Array<{ price: string; size: string }>;
    }
): Promise<MockOrderResult> => {
    try {
        const orderBook = orderBookOverride ?? await clobClient.getOrderBook(asset);

        if (side === 'BUY') {
            if (!orderBook.asks || orderBook.asks.length === 0) {
                return {
                    success: false,
                    fillPrice: 0,
                    fillSize: 0,
                    usdcAmount: 0,
                    slippage: 0,
                    reason: 'No asks available in order book',
                };
            }

            const sortedAsks = [...orderBook.asks].sort(
                (a, b) => parseFloat(a.price) - parseFloat(b.price)
            );

            let remainingUsd = amount;
            let totalTokens = 0;
            let weightedPriceSum = 0;

            for (const ask of sortedAsks) {
                if (remainingUsd <= 0) break;

                const askPrice = parseFloat(ask.price);
                const askSize = parseFloat(ask.size);
                const askValueUsd = askSize * askPrice;

                const fillUsd = Math.min(remainingUsd, askValueUsd);
                const fillTokens = fillUsd / askPrice;

                totalTokens += fillTokens;
                weightedPriceSum += fillTokens * askPrice;
                remainingUsd -= fillUsd;
            }

            if (totalTokens === 0) {
                return {
                    success: false,
                    fillPrice: 0,
                    fillSize: 0,
                    usdcAmount: 0,
                    slippage: 0,
                    reason: 'Not enough liquidity in order book',
                };
            }

            const avgFillPrice = weightedPriceSum / totalTokens;
            const slippage = ((avgFillPrice - targetPrice) / targetPrice) * 100;

            if (Math.abs(slippage) > 5) {
                const filledUsd = amount - remainingUsd;
                return {
                    success: false,
                    fillPrice: avgFillPrice,
                    fillSize: totalTokens,
                    usdcAmount: filledUsd,
                    slippage,
                    reason:
                        `Slippage too high: ${slippage.toFixed(2)}% ` +
                        `(fill $${filledUsd.toFixed(2)} @ $${avgFillPrice.toFixed(4)}, ${totalTokens.toFixed(2)} tokens)`,
                };
            }

            return {
                success: true,
                fillPrice: avgFillPrice,
                fillSize: totalTokens,
                usdcAmount: amount - remainingUsd,
                slippage,
            };
        } else {
            // SELL
            if (!orderBook.bids || orderBook.bids.length === 0) {
                return {
                    success: false,
                    fillPrice: 0,
                    fillSize: 0,
                    usdcAmount: 0,
                    slippage: 0,
                    reason: 'No bids available in order book',
                };
            }

            const validBids = orderBook.bids
                .map((bid) => ({
                    price: parseFloat(bid.price),
                    size: parseFloat(bid.size),
                }))
                .filter((bid) => bid.price > 0 && bid.size > 0);

            if (validBids.length === 0) {
                return {
                    success: false,
                    fillPrice: 0,
                    fillSize: 0,
                    usdcAmount: 0,
                    slippage: 0,
                    reason: 'No bids available in order book',
                };
            }

            const sortedBids = [...validBids].sort((a, b) => b.price - a.price);

            let remainingTokens = amount;
            let totalUsd = 0;
            let weightedPriceSum = 0;

            for (const bid of sortedBids) {
                if (remainingTokens <= 0) break;

                const bidPrice = bid.price;
                const bidSize = bid.size;

                const fillTokens = Math.min(remainingTokens, bidSize);
                const fillUsd = fillTokens * bidPrice;

                totalUsd += fillUsd;
                weightedPriceSum += fillTokens * bidPrice;
                remainingTokens -= fillTokens;
            }

            const filledTokens = amount - remainingTokens;
            if (filledTokens === 0) {
                return {
                    success: false,
                    fillPrice: 0,
                    fillSize: 0,
                    usdcAmount: 0,
                    slippage: 0,
                    reason: 'Not enough liquidity in order book',
                };
            }

            const avgFillPrice = weightedPriceSum / filledTokens;
            const slippage = ((targetPrice - avgFillPrice) / targetPrice) * 100;

            return {
                success: true,
                fillPrice: avgFillPrice,
                fillSize: filledTokens,
                usdcAmount: totalUsd,
                slippage,
            };
        }
    } catch (error) {
        return {
            success: false,
            fillPrice: 0,
            fillSize: 0,
            usdcAmount: 0,
            slippage: 0,
            reason: `Error fetching order book: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
};


/**
 * Handle BUY trade for mock mode
 * Returns the usdc amount spent (for updating task.currentBalance)
 */
export const handleBuyTrade = async (
    clobClient: ClobClient,
    trade: IUserActivity,
    task: Extract<CopyTask, { type: 'mock' }>,
    myPosition: PositionData | undefined
): Promise<number> => {
    logger.info(`[MOCK] Executing BUY strategy for ${trade.slug}...`);
    const taskWallet = task.myWalletAddress || '';

    // Skip if price is too high
    if (trade.price > 0.99) {
        logger.info(`[MOCK] Skip trade ${trade.slug} - price too high (${trade.price})`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Skip if already have position (for BUY)
    if (myPosition && myPosition.size > 0) {
        logger.info(`[MOCK] Skip trade ${trade.slug} - already have position`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    const skipBalanceCheck = task.initialFinance <= 0;

    if (!skipBalanceCheck) {
        logger.info(`[MOCK] Current balance: $${task.currentBalance.toFixed(2)}`);
    }
    logger.info(`[MOCK] Trader bought: $${trade.usdcSize.toFixed(2)}`);

    // Calculate order size (fixed amount strategy)
    const orderCalc = skipBalanceCheck
        ? {
            fixedAmount: task.fixedAmount,
            finalAmount: task.fixedAmount,
            reducedByBalance: false,
            reasoning: `Fixed amount: $${task.fixedAmount.toFixed(2)} (live mode, balance check skipped)`,
        }
        : calculateOrderSize(task.fixedAmount, task.currentBalance);

    logger.info(`[MOCK] ${orderCalc.reasoning}`);

    if (orderCalc.finalAmount === 0) {
        logger.info(`[MOCK] Cannot execute: ${orderCalc.reasoning}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Simulate order execution
    const result = await simulateOrderExecution(
        clobClient,
        trade.asset,
        'BUY',
        orderCalc.finalAmount,
        trade.price
    );

    if (!result.success) {
        logger.info(
            `[MOCK] Order simulation failed: ${result.reason} ` +
            `(copy price: $${trade.price.toFixed(4)}, amount: $${orderCalc.finalAmount.toFixed(2)})`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    logger.info(
        `[MOCK] Bought $${result.usdcAmount.toFixed(2)} ` +
        `(copy price: $${trade.price.toFixed(4)}, fill: $${result.fillPrice.toFixed(4)}) ` +
        `(${result.fillSize.toFixed(2)} tokens, slippage: ${result.slippage.toFixed(2)}%)`
    );

    // Create or update position in database
    await MockPosition.findOneAndUpdate(
        { taskId: task.id, asset: trade.asset, conditionId: trade.conditionId },
        {
            asset: trade.asset,
            conditionId: trade.conditionId,
            size: result.fillSize,
            avgPrice: result.fillPrice,
            initialValue: result.usdcAmount,
            currentValue: result.fillSize * result.fillPrice,
            cashPnl: 0,
            percentPnl: 0,
            totalBought: result.usdcAmount,
            realizedPnl: 0,
            percentRealizedPnl: 0,
            curPrice: result.fillPrice,
            redeemable: false,
            mergeable: false,
            title: trade.title,
            slug: trade.slug,
            icon: trade.icon,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
            outcomeIndex: trade.outcomeIndex,
            taskId: task.id,
        },
        { upsert: true }
    );

    await persistTradeRecord({
        taskId: task.id,
        taskType: 'mock',
        side: trade.side,
        proxyWallet: taskWallet,
        asset: trade.asset,
        conditionId: trade.conditionId,
        outcomeIndex: trade.outcomeIndex,
        fillPrice: result.fillPrice,
        fillSize: result.fillSize,
        usdcAmount: result.usdcAmount,
        slippage: result.slippage,
        positionSizeBefore: myPosition?.size ?? 0,
        positionSizeAfter: result.fillSize,
        sourceActivityId: trade._id,
        sourceTransactionHash: trade.transactionHash,
        sourceTimestamp: trade.timestamp,
        title: trade.title,
        slug: trade.slug,
        eventSlug: trade.eventSlug,
        outcome: trade.outcome,
    });

    // Mark original trade as processed (use 888 to indicate mock mode)
    await UserActivity.updateOne(
        { _id: trade._id },
        { bot: true, botExcutedTime: 888 }
    );

    // Return usdc amount spent for balance update
    return result.usdcAmount;
};

/**
 * Handle SELL trade for mock mode
 * Returns the usdc amount received (for updating task.currentBalance)
 */
export const handleSellTrade = async (
    clobClient: ClobClient,
    trade: IUserActivity,
    task: Extract<CopyTask, { type: 'mock' }>,
    myPosition: PositionData | undefined,
    copyTraderPosition: PositionData | undefined
): Promise<number> => {
    logger.info(`[MOCK] Executing SELL strategy for ${trade.slug}...`);
    const taskWallet = task.myWalletAddress || '';

    // Skip if no position to sell
    if (!myPosition || myPosition.size <= 0) {
        logger.info(`[MOCK] No position to sell for ${trade.slug}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Calculate sell amount based on copy trader's sell ratio
    let sellAmount: number;

    if (copyTraderPosition && copyTraderPosition.size > 0) {
        // Reconstruct the trader's position before any unprocessed sells
        // to avoid inflated ratios when multiple sell activities pile up
        const unprocessedSells = await UserActivity.find({
            asset: trade.asset,
            conditionId: trade.conditionId,
            side: 'SELL',
            bot: { $ne: true },
            taskId: task.id,
        }).exec();
        const totalUnprocessedSellSize = unprocessedSells.reduce((sum, s) => sum + s.size, 0);
        const reconstructedPosition = copyTraderPosition.size + totalUnprocessedSellSize;

        const copyTraderSellRatio = trade.size / reconstructedPosition;
        sellAmount = myPosition.size * copyTraderSellRatio;
        logger.info(`[MOCK] Reconstructed trader position before sells: ${reconstructedPosition.toFixed(2)} tokens (current: ${copyTraderPosition.size.toFixed(2)} + pending sells: ${totalUnprocessedSellSize.toFixed(2)})`);
        logger.info(`[MOCK] Copy trader sold ${(copyTraderSellRatio * 100).toFixed(2)}% of position`);
        logger.info(`[MOCK] My position: ${myPosition.size.toFixed(2)} tokens, selling: ${sellAmount.toFixed(2)} tokens`);
    } else {
        // Copy trader sold entire position, sell all
        sellAmount = myPosition.size;
        logger.info(`[MOCK] Copy trader closed position, selling all: ${sellAmount.toFixed(2)} tokens`);
    }

    // Check minimum order size
    if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
        logger.info(`[MOCK] Sell amount ${sellAmount.toFixed(2)} tokens below minimum`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Simulate sell order
    const result = await simulateOrderExecution(
        clobClient,
        trade.asset,
        'SELL',
        sellAmount,
        trade.price
    );

    if (!result.success) {
        logger.info(
            `[MOCK] Order simulation failed: ${result.reason} ` +
            `(copy price: $${trade.price.toFixed(4)}, amount: ${sellAmount.toFixed(2)} tokens)`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    logger.info(
        `[MOCK] Sold ${result.fillSize.toFixed(2)} tokens ` +
        `(copy price: $${trade.price.toFixed(4)}, fill: $${result.fillPrice.toFixed(4)}) ` +
        `($${result.usdcAmount.toFixed(2)}, slippage: ${result.slippage.toFixed(2)}%)`
    );

    // Update position using shared utility
    const sellResult = await updateMockPositionAfterSell({
        taskId: task.id,
        asset: trade.asset,
        conditionId: trade.conditionId,
        fillSize: result.fillSize,
        fillPrice: result.fillPrice,
        avgPrice: myPosition.avgPrice,
        positionSize: myPosition.size,
        totalBought: myPosition.totalBought,
        initialValue: myPosition.initialValue,
    }, '[MOCK]');

    await persistTradeRecord({
        taskId: task.id,
        taskType: 'mock',
        side: trade.side,
        proxyWallet: taskWallet,
        asset: trade.asset,
        conditionId: trade.conditionId,
        outcomeIndex: trade.outcomeIndex,
        fillPrice: result.fillPrice,
        fillSize: result.fillSize,
        usdcAmount: result.usdcAmount,
        slippage: result.slippage,
        costBasisPrice: myPosition.avgPrice,
        soldCost: sellResult.soldCost,
        realizedPnl: sellResult.realizedPnl,
        positionSizeBefore: myPosition.size,
        positionSizeAfter: sellResult.positionSizeAfter,
        sourceActivityId: trade._id,
        sourceTransactionHash: trade.transactionHash,
        sourceTimestamp: trade.timestamp,
        title: trade.title,
        slug: trade.slug,
        eventSlug: trade.eventSlug,
        outcome: trade.outcome,
    });

    // Mark original trade as processed
    await UserActivity.updateOne(
        { _id: trade._id },
        { bot: true, botExcutedTime: 888 }
    );

    logger.info(`[MOCK] Realized PnL: $${sellResult.realizedPnl.toFixed(2)}`);

    // Return usdc amount received for balance update
    return result.usdcAmount;
};

/**
 * Handle BUY trade for live mode (real order execution)
 * Returns the usdc amount spent (for updating task.currentBalance)
 */
export const handleLiveBuyTrade = async (
    trade: IUserActivity,
    task: Extract<CopyTask, { type: 'live' }>,
    myPosition: PositionData | undefined
): Promise<number> => {
    logger.info(`[LIVE] Executing BUY strategy for ${trade.slug}...`);

    // Skip if price is too high
    if (trade.price > 0.99) {
        logger.info(`[LIVE] Skip trade ${trade.slug} - price too high (${trade.price})`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Skip if already have position (for BUY)
    if (myPosition && myPosition.size > 0) {
        logger.info(`[LIVE] Skip trade ${trade.slug} - already have position`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Check local database for recent successful buys to prevent multi-buy due to API latency
    const existingBuy = await UserActivity.findOne({
        taskId: task.id,
        conditionId: trade.conditionId,
        side: 'BUY',
        bot: true,
        myBoughtSize: { $gt: 0 }
    });

    if (existingBuy) {
        logger.info(`[LIVE] Skip trade ${trade.slug} - found recent local purchase (API latency protection)`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Live mode: Always fetch on-chain balance before trading
    let currentBalance: number;
    try {
        currentBalance = await getMyBalance(task.myWalletAddress);
        logger.info(`[LIVE] On-chain balance: $${currentBalance.toFixed(2)}`);
    } catch (error) {
        logger.error({ err: error }, '[LIVE] Failed to fetch on-chain balance');
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    logger.info(`[LIVE] Trader bought: $${trade.usdcSize.toFixed(2)}`);

    // Calculate order size (fixed amount strategy) - always check balance in live mode
    const orderCalc = calculateOrderSize(task.fixedAmount, currentBalance);

    logger.info(`[LIVE] ${orderCalc.reasoning}`);

    if (orderCalc.finalAmount === 0) {
        logger.info(`[LIVE] Cannot execute: ${orderCalc.reasoning}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    let remaining = orderCalc.finalAmount;
    let retry = 0;
    let abortDueToFunds = false;
    let totalBoughtTokens = 0;
    let totalSpentUsd = 0;

    let clobClient: ClobClient;
    try {
        clobClient = await getTradingClobClient(task);
    } catch (error) {
        logger.error({ err: error }, `[LIVE] Failed to init trading client`);
        return 0;
    }

    while (remaining > 0 && retry < LIVE_RETRY_LIMIT) {
        const orderBook = await clobClient.getOrderBook(trade.asset);
        if (!orderBook.asks || orderBook.asks.length === 0) {
            logger.warn('[LIVE] No asks available in order book');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            break;
        }

        const minPriceAsk = orderBook.asks.reduce((min, ask) => {
            return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
        }, orderBook.asks[0]);

        logger.info(`[LIVE] Best ask: ${minPriceAsk.size} @ $${minPriceAsk.price}`);
        if (parseFloat(minPriceAsk.price) - 0.05 > trade.price) {
            logger.warn('[LIVE] Price slippage too high - skipping trade');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            break;
        }

        if (remaining < MIN_ORDER_SIZE_USD) {
            logger.info(
                `[LIVE] Remaining amount ($${remaining.toFixed(2)}) below minimum - completing trade`
            );
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
            break;
        }

        const maxOrderSize = parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price);
        const orderSize = Math.min(remaining, maxOrderSize);

        const orderArgs = {
            side: Side.BUY,
            tokenID: trade.asset,
            amount: orderSize,
            price: parseFloat(minPriceAsk.price),
        };

        logger.info(
            `[LIVE] Creating order: $${orderSize.toFixed(2)} @ $${minPriceAsk.price} (Balance: $${currentBalance.toFixed(2)})`
        );

        const signedOrder = await clobClient.createMarketOrder(orderArgs);
        const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
        if (resp?.success === true) {
            retry = 0;
            const tokensBought = orderArgs.amount / orderArgs.price;
            totalBoughtTokens += tokensBought;
            totalSpentUsd += orderArgs.amount;
            logger.info(
                `[LIVE] Bought $${orderArgs.amount.toFixed(2)} at $${orderArgs.price} (${tokensBought.toFixed(2)} tokens)`
            );
            remaining -= orderArgs.amount;
        } else {
            const errorMessage = extractOrderError(resp);
            if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                abortDueToFunds = true;
                logger.warn(
                    `[LIVE] Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                );
                logger.warn(
                    '[LIVE] Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                );
                break;
            }
            retry += 1;
            logger.warn(
                `[LIVE] Order failed (attempt ${retry}/${LIVE_RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
            );
        }
    }

    if (abortDueToFunds) {
        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, botExcutedTime: LIVE_RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
        );
        return totalSpentUsd;
    }
    if (retry >= LIVE_RETRY_LIMIT) {
        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
        );
    } else {
        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, myBoughtSize: totalBoughtTokens }
        );
    }

    if (totalBoughtTokens > 0) {
        const avgFillPrice = totalSpentUsd / totalBoughtTokens;
        await persistTradeRecord({
            taskId: task.id,
            taskType: 'live',
            side: trade.side,
            proxyWallet: task.myWalletAddress,
            asset: trade.asset,
            conditionId: trade.conditionId,
            outcomeIndex: trade.outcomeIndex,
            fillPrice: avgFillPrice,
            fillSize: totalBoughtTokens,
            usdcAmount: totalSpentUsd,
            slippage: ((avgFillPrice - trade.price) / trade.price) * 100,
            positionSizeBefore: myPosition?.size ?? 0,
            positionSizeAfter: (myPosition?.size ?? 0) + totalBoughtTokens,
            sourceActivityId: trade._id,
            sourceTransactionHash: trade.transactionHash,
            sourceTimestamp: trade.timestamp,
            title: trade.title,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
        });
        logger.info(
            `[LIVE] Tracked purchase: ${totalBoughtTokens.toFixed(2)} tokens for future sell calculations`
        );
    }

    return totalSpentUsd;
};

/**
 * Handle SELL trade for live mode (real order execution)
 * Returns the usdc amount received (for updating task.currentBalance)
 */
export const handleLiveSellTrade = async (
    trade: IUserActivity,
    task: Extract<CopyTask, { type: 'live' }>,
    myPosition: PositionData | undefined,
    copyTraderPosition: PositionData | undefined
): Promise<number> => {
    logger.info(`[LIVE] Executing SELL strategy for ${trade.slug}...`);

    if (!myPosition || myPosition.size <= 0) {
        logger.info(`[LIVE] No position to sell for ${trade.slug}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Get all previous BUY trades for this asset to calculate total bought
    const previousBuys = await UserActivity.find({
        asset: trade.asset,
        conditionId: trade.conditionId,
        side: 'BUY',
        bot: true,
        myBoughtSize: { $exists: true, $gt: 0 },
        taskId: task.id,
    }).exec();

    const totalBoughtTokens = previousBuys.reduce(
        (sum, buy) => sum + (buy.myBoughtSize || 0),
        0
    );

    if (totalBoughtTokens > 0) {
        logger.info(
            `[LIVE] Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
        );
    }

    // Reconstruct the trader's position before any unprocessed sells
    const unprocessedSells = await UserActivity.find({
        asset: trade.asset,
        conditionId: trade.conditionId,
        side: 'SELL',
        bot: { $ne: true },
        taskId: task.id,
    }).exec();
    const totalUnprocessedSellSize = unprocessedSells.reduce((sum, s) => sum + s.size, 0);

    let remaining = 0;
    if (!copyTraderPosition) {
        remaining = myPosition.size;
        logger.info(
            `[LIVE] Copy trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
        );
    } else {
        const reconstructedPosition = copyTraderPosition.size + totalUnprocessedSellSize;
        const traderSellPercent = trade.size / reconstructedPosition;

        logger.info(
            `[LIVE] Reconstructed trader position before sells: ${reconstructedPosition.toFixed(2)} tokens (current: ${copyTraderPosition.size.toFixed(2)} + pending sells: ${totalUnprocessedSellSize.toFixed(2)})`
        );
        logger.info(
            `[LIVE] Position comparison: Trader had ${reconstructedPosition.toFixed(2)} tokens, You have ${myPosition.size.toFixed(2)} tokens`
        );
        logger.info(
            `[LIVE] Trader selling: ${trade.size.toFixed(2)} tokens (${(traderSellPercent * 100).toFixed(2)}% of their position)`
        );

        let baseSellSize = 0;
        if (totalBoughtTokens > 0) {
            baseSellSize = totalBoughtTokens * traderSellPercent;
            logger.info(
                `[LIVE] Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(traderSellPercent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
            );
        } else {
            baseSellSize = myPosition.size * traderSellPercent;
            logger.warn(
                `[LIVE] No tracked purchases found, using current position: ${myPosition.size.toFixed(2)} × ${(traderSellPercent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
            );
        }

        remaining = baseSellSize;
    }

    if (remaining < MIN_ORDER_SIZE_TOKENS) {
        logger.warn(
            `[LIVE] Cannot execute: Sell amount ${remaining.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        return 0;
    }

    if (remaining > myPosition.size) {
        logger.warn(
            `[LIVE] Calculated sell ${remaining.toFixed(2)} tokens > Your position ${myPosition.size.toFixed(2)} tokens`
        );
        logger.warn(`[LIVE] Capping to maximum available: ${myPosition.size.toFixed(2)} tokens`);
        remaining = myPosition.size;
    }

    let clobClient: ClobClient;
    try {
        clobClient = await getTradingClobClient(task);
    } catch (error) {
        logger.error({ err: error }, `[LIVE] Failed to init trading client`);
        return 0;
    }

    // Execute sell orders using shared utility
    const sellResult = await executeLiveSellOrders(
        clobClient,
        trade.asset,
        remaining,
        '[LIVE]'
    );

    const { totalSoldTokens, totalReceivedUsd, abortedDueToFunds, retryCount } = sellResult;

    if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
        const sellPercentage = totalSoldTokens / totalBoughtTokens;

        if (sellPercentage >= 0.99) {
            await UserActivity.updateMany(
                {
                    asset: trade.asset,
                    conditionId: trade.conditionId,
                    side: 'BUY',
                    bot: true,
                    myBoughtSize: { $exists: true, $gt: 0 },
                    taskId: task.id,
                },
                { $set: { myBoughtSize: 0 } }
            );
            logger.info(
                `[LIVE] Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
            );
        } else {
            for (const buy of previousBuys) {
                const prevSize = buy.myBoughtSize || 0;
                const newSize = prevSize * (1 - sellPercentage);
                await UserActivity.updateOne(
                    { _id: buy._id },
                    { $set: { myBoughtSize: newSize } }
                );
            }
            logger.info(
                `[LIVE] Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
            );
        }
    }

    if (abortedDueToFunds) {
        await UserActivity.updateOne(
            { _id: trade._id },
            { bot: true, botExcutedTime: LIVE_RETRY_LIMIT }
        );
        // Still record the partial trade if any tokens were sold
        if (totalSoldTokens > 0) {
            const avgFillPrice = totalReceivedUsd / totalSoldTokens;
            await persistTradeRecord({
                taskId: task.id,
                taskType: 'live',
                side: trade.side,
                proxyWallet: task.myWalletAddress,
                asset: trade.asset,
                conditionId: trade.conditionId,
                outcomeIndex: trade.outcomeIndex,
                fillPrice: avgFillPrice,
                fillSize: totalSoldTokens,
                usdcAmount: totalReceivedUsd,
                slippage: ((trade.price - avgFillPrice) / trade.price) * 100,
                positionSizeBefore: myPosition.size,
                positionSizeAfter: myPosition.size - totalSoldTokens,
                sourceActivityId: trade._id,
                sourceTransactionHash: trade.transactionHash,
                sourceTimestamp: trade.timestamp,
                title: trade.title,
                slug: trade.slug,
                eventSlug: trade.eventSlug,
                outcome: trade.outcome,
            });
        }
        return totalReceivedUsd;
    }
    if (retryCount >= LIVE_RETRY_LIMIT) {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retryCount });
    } else {
        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
    }

    // Record the trade
    if (totalSoldTokens > 0) {
        const avgFillPrice = totalReceivedUsd / totalSoldTokens;
        await persistTradeRecord({
            taskId: task.id,
            taskType: 'live',
            side: trade.side,
            proxyWallet: task.myWalletAddress,
            asset: trade.asset,
            conditionId: trade.conditionId,
            outcomeIndex: trade.outcomeIndex,
            fillPrice: avgFillPrice,
            fillSize: totalSoldTokens,
            usdcAmount: totalReceivedUsd,
            slippage: ((trade.price - avgFillPrice) / trade.price) * 100,
            positionSizeBefore: myPosition.size,
            positionSizeAfter: myPosition.size - totalSoldTokens,
            sourceActivityId: trade._id,
            sourceTransactionHash: trade.transactionHash,
            sourceTimestamp: trade.timestamp,
            title: trade.title,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
        });
    }

    return totalReceivedUsd;
};

/**
 * Handle REDEEM trade for resolved markets
 * Returns the usdc amount redeemed (for updating task.currentBalance)
 */
export const handleRedeemTrade = async (
    trade: IUserActivity,
    task: CopyTask,
    myPosition: PositionData | undefined
): Promise<number> => {
    const positionLabel = trade.slug || trade.conditionId || 'unknown';
    logger.info(`[REDEEM] Handling redeem event for ${positionLabel}...`);

    if (!myPosition || myPosition.size <= 0) {
        logger.info(`[REDEEM] No position to redeem for ${positionLabel}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    const result = await redeemPosition(task, myPosition);

    await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });

    if (!result.success) {
        return 0;
    }

    return result.value;
};

export const forcedClosePosition = async (
    myPosition: PositionData,
    task: CopyTask
): Promise<number> => {
    if (!myPosition || myPosition.size <= 0) {
        return 0;
    }
    const taskWallet = task.myWalletAddress || '';

    // Get CLOB client for orderbook
    const clobClient = getClobClient();

    // Normal case: market is still active, try to sell via order book
    const orderBook = await clobClient.getOrderBook(myPosition.asset);
    const validBids = (orderBook.bids || [])
        .map((bid) => ({
            price: parseFloat(bid.price),
            size: parseFloat(bid.size),
        }))
        .filter((bid) => bid.price > 0 && bid.size > 0);

    if (validBids.length === 0) {
        logger.info(`[FORCED_CLOSE] No bids in order book; treating as redeemable`);
        const result = await redeemPosition(task, myPosition);
        return result.value;
    }

    const bestBidPrice = validBids.reduce(
        (max, bid) => (bid.price > max ? bid.price : max),
        0
    );

    const targetPrice = bestBidPrice;

    if (targetPrice <= 0) {
        logger.warn(`[FORCED_CLOSE] Missing current price for ${myPosition.slug}, skipping close`);
        return 0;
    }

    logger.info(`[FORCED_CLOSE] Closing position for ${myPosition.slug}...`);

    // Handle LIVE trading mode - execute real orders
    if (task.type === 'live') {
        let tradingClient: ClobClient;
        try {
            tradingClient = await getTradingClobClient(task);
        } catch (error) {
            logger.error({ err: error }, `[FORCED_CLOSE] Failed to init trading client`);
            return 0;
        }

        // Execute sell orders using shared utility
        const sellResult = await executeLiveSellOrders(
            tradingClient,
            myPosition.asset,
            myPosition.size,
            '[FORCED_CLOSE]'
        );

        const { totalSoldTokens, totalReceivedUsd, abortedDueToFunds } = sellResult;

        if (totalSoldTokens > 0) {
            const avgFillPrice = totalReceivedUsd / totalSoldTokens;
            const costBasisPrice = myPosition.avgPrice > 0 ? myPosition.avgPrice : avgFillPrice;
            const soldCost = totalSoldTokens * costBasisPrice;
            const realizedPnl = totalReceivedUsd - soldCost;

            logger.info(
                `[FORCED_CLOSE] LIVE total sold: ${totalSoldTokens.toFixed(2)} tokens for $${totalReceivedUsd.toFixed(2)}`
            );
            logger.info(`[FORCED_CLOSE] Realized PnL: $${realizedPnl.toFixed(2)}`);
        }

        if (abortedDueToFunds) {
            logger.warn('[FORCED_CLOSE] Aborted due to insufficient funds');
        }

        return totalReceivedUsd;
    }

    // Handle MOCK trading mode - simulate order execution
    const result = await simulateOrderExecution(
        clobClient,
        myPosition.asset,
        'SELL',
        myPosition.size,
        targetPrice,
        orderBook
    );

    if (!result.success) {
        if (result.reason === 'No bids available in order book') {
            logger.error(`[FORCED_CLOSE] SELL FAILED; treating as redeemable`);
            const redeemResult = await redeemPosition(task, myPosition);
            return redeemResult.value;
        }

        logger.warn(`[FORCED_CLOSE] Order simulation failed: ${result.reason}`);
        return 0;
    }

    // Update position using shared utility
    const sellResult = await updateMockPositionAfterSell({
        taskId: task.id,
        asset: myPosition.asset,
        conditionId: myPosition.conditionId,
        fillSize: result.fillSize,
        fillPrice: result.fillPrice,
        avgPrice: myPosition.avgPrice,
        positionSize: myPosition.size,
        totalBought: myPosition.totalBought,
        initialValue: myPosition.initialValue,
    }, '[FORCED_CLOSE]');

    await persistTradeRecord({
        taskId: task.id,
        taskType: 'mock',
        side: 'SELL',
        proxyWallet: taskWallet,
        asset: myPosition.asset,
        conditionId: myPosition.conditionId,
        outcomeIndex: myPosition.outcomeIndex,
        fillPrice: result.fillPrice,
        fillSize: result.fillSize,
        usdcAmount: result.usdcAmount,
        slippage: result.slippage,
        costBasisPrice: myPosition.avgPrice > 0 ? myPosition.avgPrice : result.fillPrice,
        soldCost: sellResult.soldCost,
        realizedPnl: sellResult.realizedPnl,
        positionSizeBefore: myPosition.size,
        positionSizeAfter: sellResult.positionSizeAfter,
        title: myPosition.title,
        slug: myPosition.slug,
        eventSlug: myPosition.eventSlug,
        outcome: myPosition.outcome,
    });

    logger.info(`[FORCED_CLOSE] Realized PnL: $${sellResult.realizedPnl.toFixed(2)}`);

    return result.usdcAmount;
};
