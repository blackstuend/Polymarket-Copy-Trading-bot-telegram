import { createReadOnlyClobClient } from '../services/polymarket.js';
import { getBidPriceLevels } from '../utils/orderBook.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const tokenId = args[0];
const limitArg = args[1];

if (!tokenId) {
    logger.error('Usage: pnpm tsx src/scripts/printBids.ts <tokenId> [limit]');
    process.exit(1);
}

const limit = limitArg ? Number.parseInt(limitArg, 10) : 10;
if (!Number.isFinite(limit) || limit <= 0) {
    logger.error('Invalid limit. Use a positive integer.');
    process.exit(1);
}

try {
    const client = createReadOnlyClobClient();
    const bids = await getBidPriceLevels(tokenId, client);

    if (bids.length === 0) {
        logger.info(`No bids found for tokenId: ${tokenId}`);
        process.exit(0);
    }

    logger.info(`Top ${Math.min(limit, bids.length)} bids for tokenId: ${tokenId}`);
    logger.info('price\t\tsize');

    for (const bid of bids.slice(0, limit)) {
        const price = bid.price.toFixed(4);
        const size = bid.size.toFixed(2);
        logger.info(`${price}\t\t${size}`);
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to fetch bids: ${message}`);
    process.exit(1);
}
