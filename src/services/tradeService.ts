import { UserActivity, IUserActivity } from '../models/UserActivity.js';
import { mockTradeRecrod } from '../models/mockTradeRecrod.js';
import { MyPosition } from '../models/MyPosition.js';
import { fetchData } from '../utils/fetchData.js';
import { CopyTask } from '../types/task.js';
import { PositionData } from '../types/position.js';
import { ClobClient } from '@polymarket/clob-client';
import { calculateOrderSize } from '../config/copyStrategy.js';
import { ethers } from 'ethers';
import type { Types } from 'mongoose';
import {
    CTF_ABI,
    CTF_CONTRACT_ADDRESS,
    USDC_ADDRESS,
    getOutcomePayoutRatio,
    toConditionIdBytes32,
} from '../utils/redeem.js';

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0;
const MIN_ORDER_SIZE_TOKENS = 1.0;

interface MockOrderResult {
    success: boolean;
    fillPrice: number;
    fillSize: number;
    usdcAmount: number;
    slippage: number;
    reason?: string;
}

const persistMockTradeRecrod = async (
    data: {
        taskId: string;
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
    }
): Promise<void> => {
    try {
        await mockTradeRecrod.create({
            ...data,
            executedAt: data.executedAt ?? Date.now(),
        });
    } catch (error) {
        console.error(`[MOCK] Failed to persist mock trade record: ${error}`);
    }
};

export const syncTradeData = async (task: CopyTask) => {
    const address = task.address;
    const ONE_HOUR_IN_SECONDS = 60 * 60;
    const TOO_OLD_TIMESTAMP = Math.floor(Date.now() / 1000) - ONE_HOUR_IN_SECONDS;

    try {
        // Fetch trade activities from Polymarket API
        const apiUrl = `https://data-api.polymarket.com/activity?user=${address}`;
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

            // Check if already in DB
            const exists = await UserActivity.findOne({ transactionHash: activity.transactionHash }).exec();
            if (exists) {
                seenConditions.add(activity.conditionId);
                continue;
            }

            // Duplicate conditionId → mark as processed
            const isDuplicate = seenConditions.has(activity.conditionId);
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
            console.log(`New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}: ${activity.transactionHash}${isDuplicate ? ' (duplicate, skipped)' : ''}`);
        }
    } catch (error) {
        console.error(
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
 * 取得目前的 positions
 * 如果是 mock 則從資料庫獲取，如果是 live 則從 API 獲取
 * 資料格式與 API 回傳格式一致
 * @param task - 任務資訊
 * @returns Position 資料列表
 */
export const getMyPositions = async (task: CopyTask): Promise<PositionData[]> => {
    const address = task.address;

    try {
        if (task.type === 'mock') {
            // 從資料庫獲取 positions (mock 模式只用 taskId 查詢)
            const dbPositions = await MyPosition.find({
                taskId: task.id,
                proxyWallet: task.wallet,
            }).exec();

            // 轉換資料庫格式為 API 格式
            const positions: PositionData[] = dbPositions.map((pos) => ({
                proxyWallet: pos.proxyWallet,
                asset: pos.asset,
                conditionId: pos.conditionId,
                size: pos.size,
                avgPrice: pos.avgPrice,
                initialValue: pos.initialValue,
                currentValue: pos.currentValue,
                cashPnl: pos.cashPnl,
                percentPnl: pos.percentPnl,
                totalBought: pos.totalBought,
                realizedPnl: pos.realizedPnl,
                percentRealizedPnl: pos.percentRealizedPnl,
                curPrice: pos.curPrice,
                redeemable: pos.redeemable,
                mergeable: pos.mergeable,
                title: pos.title,
                slug: pos.slug,
                icon: pos.icon,
                eventSlug: pos.eventSlug,
                outcome: pos.outcome,
                outcomeIndex: pos.outcomeIndex,
                oppositeOutcome: pos.oppositeOutcome,
                oppositeAsset: pos.oppositeAsset,
                endDate: pos.endDate,
                negativeRisk: pos.negativeRisk,
            }));

            return positions;
        } else {
            // 從 API 獲取 positions
            const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
            const apiPositions = await fetchData(positionsUrl);

            if (Array.isArray(apiPositions)) {
                return apiPositions as PositionData[];
            }

            return [];
        }
    } catch (error) {
        console.error(`Error getting positions for task ${task.id}: ${error}`);
        throw error;
    }
};


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

            if (slippage > 5) {
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
    task: CopyTask,
    myPosition: PositionData | undefined
): Promise<number> => {
    console.log(`[MOCK] Executing BUY strategy for ${trade.slug}...`);
    const taskWallet = task.wallet;

    // Skip if price is too high
    if (trade.price > 0.99) {
        console.log(`[MOCK] Skip trade ${trade.slug} - price too high (${trade.price})`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Skip if already have position (for BUY)
    if (myPosition && myPosition.size > 0) {
        console.log(`[MOCK] Skip trade ${trade.slug} - already have position`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    console.log(`[MOCK] Current balance: $${task.currentBalance.toFixed(2)}`);
    console.log(`[MOCK] Trader bought: $${trade.usdcSize.toFixed(2)}`);

    // Calculate order size (fixed amount strategy)
    const orderCalc = calculateOrderSize(task.fixedAmount, task.currentBalance);

    console.log(`[MOCK] ${orderCalc.reasoning}`);

    if (orderCalc.finalAmount === 0) {
        console.log(`[MOCK] Cannot execute: ${orderCalc.reasoning}`);
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
        console.log(
            `[MOCK] Order simulation failed: ${result.reason} ` +
            `(copy price: $${trade.price.toFixed(4)}, amount: $${orderCalc.finalAmount.toFixed(2)})`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    console.log(
        `[MOCK] Bought $${result.usdcAmount.toFixed(2)} ` +
        `(copy price: $${trade.price.toFixed(4)}, fill: $${result.fillPrice.toFixed(4)}) ` +
        `(${result.fillSize.toFixed(2)} tokens, slippage: ${result.slippage.toFixed(2)}%)`
    );

    // Create or update position in database
    await MyPosition.findOneAndUpdate(
        { taskId: task.id, asset: trade.asset, conditionId: trade.conditionId, proxyWallet: taskWallet },
        {
            proxyWallet: taskWallet,
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

    await persistMockTradeRecrod({
        taskId: task.id,
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
    task: CopyTask,
    myPosition: PositionData | undefined,
    copyTraderPosition: PositionData | undefined
): Promise<number> => {
    console.log(`[MOCK] Executing SELL strategy for ${trade.slug}...`);
    const taskWallet = task.wallet;

    // Skip if no position to sell
    if (!myPosition || myPosition.size <= 0) {
        console.log(`[MOCK] No position to sell for ${trade.slug}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    // Calculate sell amount based on copy trader's sell ratio
    let sellAmount: number;

    if (copyTraderPosition && copyTraderPosition.size > 0) {
        // Calculate the ratio of how much the copy trader sold
        const copyTraderSellRatio = trade.size / (trade.size + copyTraderPosition.size);
        sellAmount = myPosition.size * copyTraderSellRatio;
        console.log(`[MOCK] Copy trader sold ${(copyTraderSellRatio * 100).toFixed(2)}% of position`);
        console.log(`[MOCK] My position: ${myPosition.size.toFixed(2)} tokens, selling: ${sellAmount.toFixed(2)} tokens`);
    } else {
        // Copy trader sold entire position, sell all
        sellAmount = myPosition.size;
        console.log(`[MOCK] Copy trader closed position, selling all: ${sellAmount.toFixed(2)} tokens`);
    }

    // Check minimum order size
    if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
        console.log(`[MOCK] Sell amount ${sellAmount.toFixed(2)} tokens below minimum`);
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
        console.log(
            `[MOCK] Order simulation failed: ${result.reason} ` +
            `(copy price: $${trade.price.toFixed(4)}, amount: ${sellAmount.toFixed(2)} tokens)`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    console.log(
        `[MOCK] Sold ${result.fillSize.toFixed(2)} tokens ` +
        `(copy price: $${trade.price.toFixed(4)}, fill: $${result.fillPrice.toFixed(4)}) ` +
        `($${result.usdcAmount.toFixed(2)}, slippage: ${result.slippage.toFixed(2)}%)`
    );

    // Calculate realized PnL
    const soldCost = result.fillSize * myPosition.avgPrice;
    const realizedPnl = result.usdcAmount - soldCost;

    // Update position
    const newSize = myPosition.size - result.fillSize;
    const positionSizeAfter = newSize <= 0.01 ? 0 : newSize;

    if (newSize <= 0.01) {
        // Close position entirely
        await MyPosition.deleteOne({ taskId: task.id, asset: trade.asset, conditionId: trade.conditionId, proxyWallet: taskWallet });
        console.log(`[MOCK] Position closed`);
    } else {
        // Partial close
        const newTotalBought = (myPosition.totalBought || myPosition.initialValue) - soldCost;
        await MyPosition.updateOne(
            { taskId: task.id, asset: trade.asset, conditionId: trade.conditionId, proxyWallet: taskWallet },
            {
                $set: {
                    size: newSize,
                    totalBought: newTotalBought,
                    currentValue: newSize * result.fillPrice,
                    cashPnl: newSize * result.fillPrice - newTotalBought,
                    percentPnl: ((newSize * result.fillPrice - newTotalBought) / newTotalBought) * 100,
                    curPrice: result.fillPrice,
                },
                $inc: {
                    realizedPnl: realizedPnl,
                },
            }
        );
        console.log(`[MOCK] Position updated, remaining: ${newSize.toFixed(2)} tokens`);
    }

    await persistMockTradeRecrod({
        taskId: task.id,
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
        soldCost: soldCost,
        realizedPnl: realizedPnl,
        positionSizeBefore: myPosition.size,
        positionSizeAfter: positionSizeAfter,
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

    console.log(`[MOCK] Realized PnL: $${realizedPnl.toFixed(2)}`);

    // Return usdc amount received for balance update
    return result.usdcAmount;
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
    console.log(`[REDEEM] Handling redeem event for ${positionLabel}...`);

    if (!myPosition || myPosition.size <= 0) {
        console.log(`[REDEEM] No position to redeem for ${positionLabel}`);
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });
        return 0;
    }

    const liveConfig = task.type === 'live' && task.privateKey && task.rpcUrl
        ? { privateKey: task.privateKey, rpcUrl: task.rpcUrl }
        : undefined;

    const result = await redeemPosition(task, myPosition, liveConfig);

    await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 888 });

    if (!result.success) {
        return 0;
    }

    return result.value;
};

export const forcedClosePosition = async (
    clobClient: ClobClient,
    task: CopyTask,
    myPosition: PositionData,
    liveConfig?: { privateKey: string; rpcUrl: string }
): Promise<number> => {
    if (!myPosition || myPosition.size <= 0) {
        return 0;
    }
    const taskWallet = task.wallet;

    // Normal case: market is still active, try to sell via order book
    const orderBook = await clobClient.getOrderBook(myPosition.asset);
    const validBids = (orderBook.bids || [])
        .map((bid) => ({
            price: parseFloat(bid.price),
            size: parseFloat(bid.size),
        }))
        .filter((bid) => bid.price > 0 && bid.size > 0);

    if (validBids.length === 0) {
        console.log(`[FORCED_CLOSE] No bids in order book; treating as resolved`);
        const result = await redeemPosition(task, myPosition, liveConfig);
        return result.value;
    }

    const bestBidPrice = validBids.reduce(
        (max, bid) => (bid.price > max ? bid.price : max),
        0
    );
    
    const targetPrice = bestBidPrice;

    if (targetPrice <= 0) {
        console.log(`[FORCED_CLOSE] Missing current price for ${myPosition.slug}, skipping close`);
        return 0;
    }

    console.log(`[FORCED_CLOSE] Closing position for ${myPosition.slug}...`);

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
            console.log(`[FORCED_CLOSE] No bids in order book; treating as resolved`);
            const redeemResult = await redeemPosition(task, myPosition, liveConfig);
            return redeemResult.value;
        }

        console.log(`[FORCED_CLOSE] Order simulation failed: ${result.reason}`);
        return 0;
    }

    const costBasisPrice = myPosition.avgPrice > 0 ? myPosition.avgPrice : targetPrice;
    const soldCost = result.fillSize * costBasisPrice;
    const realizedPnl = result.usdcAmount - soldCost;

    const newSize = myPosition.size - result.fillSize;
    const positionSizeAfter = newSize <= 0.01 ? 0 : newSize;

    if (newSize <= 0.01) {
        await MyPosition.deleteOne({
            taskId: task.id,
            asset: myPosition.asset,
            conditionId: myPosition.conditionId,
            proxyWallet: taskWallet,
        });
        console.log(`[FORCED_CLOSE] Position closed`);
    } else {
        const newTotalBought = (myPosition.totalBought || myPosition.initialValue) - soldCost;
        await MyPosition.updateOne(
            { taskId: task.id, asset: myPosition.asset, conditionId: myPosition.conditionId, proxyWallet: taskWallet },
            {
                $set: {
                    size: newSize,
                    totalBought: newTotalBought,
                    currentValue: newSize * result.fillPrice,
                    cashPnl: newSize * result.fillPrice - newTotalBought,
                    percentPnl: ((newSize * result.fillPrice - newTotalBought) / newTotalBought) * 100,
                    curPrice: result.fillPrice,
                },
                $inc: {
                    realizedPnl: realizedPnl,
                },
            }
        );
        console.log(`[FORCED_CLOSE] Position updated, remaining: ${newSize.toFixed(2)} tokens`);
    }

    if (task.type === 'mock') {
        await persistMockTradeRecrod({
            taskId: task.id,
            side: 'SELL',
            proxyWallet: taskWallet,
            asset: myPosition.asset,
            conditionId: myPosition.conditionId,
            outcomeIndex: myPosition.outcomeIndex,
            fillPrice: result.fillPrice,
            fillSize: result.fillSize,
            usdcAmount: result.usdcAmount,
            slippage: result.slippage,
            costBasisPrice: costBasisPrice,
            soldCost: soldCost,
            realizedPnl: realizedPnl,
            positionSizeBefore: myPosition.size,
            positionSizeAfter: positionSizeAfter,
            title: myPosition.title,
            slug: myPosition.slug,
            eventSlug: myPosition.eventSlug,
            outcome: myPosition.outcome,
        });
    }

    console.log(`[FORCED_CLOSE] Realized PnL: $${realizedPnl.toFixed(2)}`);

    return result.usdcAmount;
};

/**
 * Redeem a resolved position (supports both mock and live modes)
 * @param task - The copy task
 * @param position - Position to redeem
 * @param liveConfig - Optional live config with privateKey and rpcUrl (required for live mode)
 * @returns Object with success status, redeemed value, and realized PnL
 */
export const redeemPosition = async (
    task: CopyTask,
    position: PositionData,
    liveConfig?: { privateKey: string; rpcUrl: string }
): Promise<{ success: boolean; value: number; realizedPnl: number; error?: string }> => {
    const taskWallet = task.wallet;
    const positionLabel = position.slug || position.conditionId || 'unknown';

    if (!position || position.size <= 0) {
        return { success: false, value: 0, realizedPnl: 0, error: 'No position to redeem' };
    }

    const rpcUrl = task.rpcUrl || liveConfig?.rpcUrl;
    if (!rpcUrl) {
        console.log(`[REDEEM] Missing rpcUrl for on-chain payout check`);
        return { success: false, value: 0, realizedPnl: 0, error: 'Missing rpcUrl' };
    }

    const payoutInfo = await getOutcomePayoutRatio(rpcUrl, position.conditionId, position.outcomeIndex);
    if (!payoutInfo.settled) {
        const reason = payoutInfo.error || 'Condition not settled';
        console.log(`[REDEEM] On-chain payout unavailable for ${positionLabel}: ${reason}`);
        return { success: false, value: 0, realizedPnl: 0, error: reason };
    }

    const payoutRatio = payoutInfo.payout;
    const redeemValue = position.size * payoutRatio;
    const costBasis = position.avgPrice * position.size;
    const realizedPnl = redeemValue - costBasis;

    if (task.type === 'mock') {
        await persistMockTradeRecrod({
            taskId: task.id,
            side: 'REDEEM',
            proxyWallet: taskWallet,
            asset: position.asset,
            conditionId: position.conditionId,
            outcomeIndex: position.outcomeIndex,
            fillPrice: payoutRatio,
            fillSize: position.size,
            usdcAmount: redeemValue,
            slippage: 0,
            costBasisPrice: position.avgPrice,
            soldCost: costBasis,
            realizedPnl: realizedPnl,
            positionSizeBefore: position.size,
            positionSizeAfter: 0,
            title: position.title,
            slug: position.slug,
            eventSlug: position.eventSlug,
            outcome: position.outcome,
        });

        await MyPosition.deleteOne({
            taskId: task.id,
            asset: position.asset,
            conditionId: position.conditionId,
            proxyWallet: taskWallet,
        });

        console.log(`[REDEEM] Redeemed position (mock), payout: ${payoutRatio.toFixed(4)}, value: $${redeemValue.toFixed(2)}, PnL: $${realizedPnl.toFixed(2)}`);
        return { success: true, value: redeemValue, realizedPnl };
    }

    // Live mode: call redeem contract
    if (!liveConfig) {
        console.log(`[REDEEM] Live mode requires privateKey and rpcUrl for redemption`);
        return { success: false, value: 0, realizedPnl: 0, error: 'Missing liveConfig for live mode' };
    }

    try {
        const provider = new ethers.JsonRpcProvider(liveConfig.rpcUrl);
        const wallet = new ethers.Wallet(liveConfig.privateKey, provider);
        const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

        const conditionIdBytes32 = toConditionIdBytes32(position.conditionId);
        const parentCollectionId = ethers.ZeroHash;
        const indexSets = [1, 2];

        console.log(`[REDEEM] Attempting redemption for ${position.title || position.slug}...`);
        console.log(`[REDEEM] Condition ID: ${conditionIdBytes32}`);

        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

        if (!gasPrice) {
            throw new Error('Could not determine gas price');
        }

        const adjustedGasPrice = (gasPrice * 120n) / 100n;

        const tx = await ctfContract.redeemPositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionIdBytes32,
            indexSets,
            {
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );

        console.log(`[REDEEM] Transaction submitted: ${tx.hash}`);

        const receipt = await tx.wait();

        if (receipt && receipt.status === 1) {
            await MyPosition.deleteOne({
                taskId: task.id,
                asset: position.asset,
                conditionId: position.conditionId,
                proxyWallet: taskWallet,
            });

            console.log(`[REDEEM] Redemption successful! Gas used: ${receipt.gasUsed.toString()}, value: $${redeemValue.toFixed(2)}, PnL: $${realizedPnl.toFixed(2)}`);
            return { success: true, value: redeemValue, realizedPnl };
        } else {
            console.log(`[REDEEM] Transaction failed`);
            return { success: false, value: 0, realizedPnl: 0, error: 'Transaction reverted' };
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`[REDEEM] Redemption failed: ${errorMessage}`);
        return { success: false, value: 0, realizedPnl: 0, error: errorMessage };
    }
};

/**
 * Get copy trader's positions from API
 */
export const getCopyTraderPositions = async (address: string): Promise<PositionData[]> => {
    try {
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
        const apiPositions = await fetchData(positionsUrl);

        if (Array.isArray(apiPositions)) {
            return apiPositions as PositionData[];
        }

        return [];
    } catch (error) {
        console.error(`Error getting copy trader positions: ${error}`);
        return [];
    }
}; 
