import { MockPosition } from '../models/MockPosition.js';
import { fetchData } from './fetchData.js';
import { CopyTask } from '../types/task.js';
import { PositionData } from '../types/position.js';
import { logger } from './logger.js';

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
            const dbPositions = await MockPosition.find({
                taskId: task.id,
            }).exec();

            // 轉換資料庫格式為 API 格式
            const positions: PositionData[] = dbPositions.map((pos) => ({
                proxyWallet: '',
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
        logger.error(`Error getting positions for task ${task.id}: ${error}`);
        throw error;
    }
};
