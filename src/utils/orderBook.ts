import { ClobClient } from '@polymarket/clob-client';
import { getClobClient } from '../services/polymarket.js';

export interface BidLevel {
    price: number;
    size: number;
}

export const getBidPriceLevels = async (
    tokenId: string,
    client?: ClobClient
): Promise<BidLevel[]> => {
    const clobClient = client ?? getClobClient();
    const orderBook = await clobClient.getOrderBook(tokenId);

    return (orderBook.bids || [])
        .map((bid) => ({
            price: parseFloat(bid.price),
            size: parseFloat(bid.size),
        }))
        .filter((bid) => bid.price > 0 && bid.size > 0)
        .sort((a, b) => b.price - a.price);
};
