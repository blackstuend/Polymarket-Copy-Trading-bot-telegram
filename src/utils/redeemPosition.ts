import { ethers } from 'ethers';
import { MockPosition } from '../models/MockPosition.js';
import { CopyTask } from '../types/task.js';
import { PositionData } from '../types/position.js';
import { config } from '../config/index.js';
import { logger } from './logger.js';
import { USDC_ADDRESS } from './addresses.js';
import {
    CTF_ABI,
    CTF_CONTRACT_ADDRESS,
    getOutcomePayoutRatio,
    toConditionIdBytes32,
} from './redeem.js';
import { persistTradeRecord } from '../services/tradeService.js';

/**
 * Redeem a resolved position (supports both mock and live modes)
 * @param task - The copy task
 * @param position - Position to redeem
 * @returns Object with success status, redeemed value, and realized PnL
 */
export const redeemPosition = async (
    task: CopyTask,
    position: PositionData
): Promise<{ success: boolean; value: number; realizedPnl: number; error?: string }> => {
    const taskWallet = task.myWalletAddress || '';
    const positionLabel = position.slug || position.conditionId || 'unknown';

    if (!position || position.size <= 0) {
        return { success: false, value: 0, realizedPnl: 0, error: 'No position to redeem' };
    }

    const rpcUrl = config.polymarket.rpcUrl;
    if (!rpcUrl) {
        logger.warn(`[REDEEM] Missing RPC_URL in environment for on-chain payout check`);
        return { success: false, value: 0, realizedPnl: 0, error: 'Missing RPC_URL' };
    }

    const payoutInfo = await getOutcomePayoutRatio(rpcUrl, position.conditionId, position.outcomeIndex);
    if (!payoutInfo.settled) {
        const reason = payoutInfo.error || 'Condition not settled';
        logger.warn(`[REDEEM] On-chain payout unavailable for ${positionLabel}: ${reason}`);
        return { success: false, value: 0, realizedPnl: 0, error: reason };
    }

    const payoutRatio = payoutInfo.payout;
    const redeemValue = position.size * payoutRatio;
    const costBasis = position.avgPrice * position.size;
    const realizedPnl = redeemValue - costBasis;

    if (task.type === 'mock') {
        await persistTradeRecord({
            taskId: task.id,
            taskType: 'mock',
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

        await MockPosition.deleteOne({
            taskId: task.id,
            asset: position.asset,
            conditionId: position.conditionId,
        });

        logger.info(`[REDEEM] Redeemed position (mock), payout: ${payoutRatio.toFixed(4)}, value: $${redeemValue.toFixed(2)}, PnL: $${realizedPnl.toFixed(2)}`);
        return { success: true, value: redeemValue, realizedPnl };
    }

    // Live mode: build config from task
    if (task.type !== 'live' || !task.privateKey) {
        logger.warn(`[REDEEM] Live mode requires privateKey for redemption`);
        return { success: false, value: 0, realizedPnl: 0, error: 'Missing privateKey for live mode' };
    }

    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(task.privateKey, provider);
        const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);

        const conditionIdBytes32 = toConditionIdBytes32(position.conditionId);
        const parentCollectionId = ethers.ZeroHash;
        const indexSets = [1, 2];

        logger.info(`[REDEEM] Attempting redemption for ${position.title || position.slug}...`);
        logger.info(`[REDEEM] Condition ID: ${conditionIdBytes32}`);

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

        logger.info(`[REDEEM] Transaction submitted: ${tx.hash}`);

        const receipt = await tx.wait();

        if (receipt && receipt.status === 1) {
            await MockPosition.deleteOne({
                taskId: task.id,
                asset: position.asset,
                conditionId: position.conditionId,
            });

            // Calculate gas used in POL
            const gasUsedWei = receipt.gasUsed * (receipt.gasPrice || adjustedGasPrice);
            const gasUsedPOL = Number(ethers.formatEther(gasUsedWei));

            // Record the live redeem trade
            await persistTradeRecord({
                taskId: task.id,
                taskType: 'live',
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
                sourceTransactionHash: tx.hash,
                title: position.title,
                slug: position.slug,
                eventSlug: position.eventSlug,
                outcome: position.outcome,
                gasUsed: gasUsedPOL,
            });

            logger.info(`[REDEEM] Redemption successful! Gas used: ${gasUsedPOL.toFixed(6)} POL, value: $${redeemValue.toFixed(2)}, PnL: $${realizedPnl.toFixed(2)}`);
            return { success: true, value: redeemValue, realizedPnl };
        } else {
            logger.error(`[REDEEM] Transaction failed`);
            return { success: false, value: 0, realizedPnl: 0, error: 'Transaction reverted' };
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`[REDEEM] Redemption failed: ${errorMessage}`);
        return { success: false, value: 0, realizedPnl: 0, error: errorMessage };
    }
};
