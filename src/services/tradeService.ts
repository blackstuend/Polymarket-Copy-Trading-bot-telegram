import { UserActivity } from '../models/UserActivity.js';
import { UserPosition } from '../models/UserPosition.js';
import { fetchData } from '../utils/fetchData.js';
import { CopyTask } from '../types/task.js';
import { PositionData } from '../types/position.js';

export const syncTradeData = async (task: CopyTask) => {
    const address = task.address;
    const ONE_HOUR_IN_SECONDS = 60 * 60;
    const TOO_OLD_TIMESTAMP = Math.floor(Date.now() / 1000) - ONE_HOUR_IN_SECONDS;

    try {
        // Fetch trade activities from Polymarket API
        const apiUrl = `https://data-api.polymarket.com/activity?user=${address}&type=TRADE`;
        const activities = await fetchData(apiUrl);

        if (Array.isArray(activities) && activities.length > 0) {
            // Process each activity
            for (const activity of activities) {
                // Ensure timestamp is comparable. If API returns string, we might need parsing. 
                // However, snippet assumes activity.timestamp is a number.
                if (activity.timestamp < TOO_OLD_TIMESTAMP) {
                    continue;
                }

                // Check if this trade already exists in database
                const existingActivity = await UserActivity.findOne({
                    transactionHash: activity.transactionHash,
                }).exec();

                if (existingActivity) {
                    continue; // Already processed this trade
                }

                // Save new trade to database
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
                    bot: false,
                    botExcutedTime: 0,
                    taskId: task.id,
                });

                await newActivity.save();
                console.log(`New trade detected for ${address.slice(0, 6)}...${address.slice(-4)}: ${activity.transactionHash}`);
            }
        }

        // Also fetch and update positions
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}`;
        const positions = await fetchData(positionsUrl);

        if (Array.isArray(positions) && positions.length > 0) {
            for (const position of positions) {
                // Update or create position
                // Use proxyWallet from position if available, else fallback to task address
                const wallet = position.proxyWallet || address;

                await UserPosition.findOneAndUpdate(
                    { proxyWallet: wallet, asset: position.asset, conditionId: position.conditionId, taskId: task.id },
                    {
                        proxyWallet: wallet,
                        asset: position.asset,
                        conditionId: position.conditionId,
                        size: position.size,
                        avgPrice: position.avgPrice,
                        initialValue: position.initialValue,
                        currentValue: position.currentValue,
                        cashPnl: position.cashPnl,
                        percentPnl: position.percentPnl,
                        totalBought: position.totalBought,
                        realizedPnl: position.realizedPnl,
                        percentRealizedPnl: position.percentRealizedPnl,
                        curPrice: position.curPrice,
                        redeemable: position.redeemable,
                        mergeable: position.mergeable,
                        title: position.title,
                        slug: position.slug,
                        icon: position.icon,
                        eventSlug: position.eventSlug,
                        outcome: position.outcome,
                        outcomeIndex: position.outcomeIndex,
                        oppositeOutcome: position.oppositeOutcome,
                        oppositeAsset: position.oppositeAsset,
                        endDate: position.endDate,
                        negativeRisk: position.negativeRisk,
                        taskId: task.id,
                    },
                    { upsert: true }
                );
            }
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
            const dbPositions = await UserPosition.find({
                taskId: task.id,
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


export const handleBuyTrade = async() => {
    
}


export const handleSellTrade = async()=> {

} 
