import { fetchData } from './fetchData.js';
import { PositionData } from '../types/position.js';
import { logger } from './logger.js';

/**
 * Get copy trader's positions from API
 */
export const getCopyTraderPositions = async (address: string): Promise<PositionData[]> => {
    try {
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${address}&redeemable=false&limit=500`;
        const apiPositions = await fetchData(positionsUrl);

        if (Array.isArray(apiPositions)) {
            return apiPositions as PositionData[];
        }

        return [];
    } catch (error) {
        logger.error(`Error getting copy trader positions: ${error}`);
        return [];
    }
};
