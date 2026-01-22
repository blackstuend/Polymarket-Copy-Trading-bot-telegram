import { createReadOnlyClobClient } from '../services/polymarket.js';
import { getBidPriceLevels } from '../utils/orderBook.js';

const args = process.argv.slice(2);
const tokenId = args[0];
const limitArg = args[1];

if (!tokenId) {
    console.log('Usage: pnpm tsx src/scripts/printBids.ts <tokenId> [limit]');
    process.exit(1);
}

const limit = limitArg ? Number.parseInt(limitArg, 10) : 10;
if (!Number.isFinite(limit) || limit <= 0) {
    console.log('Invalid limit. Use a positive integer.');
    process.exit(1);
}

try {
    const client = createReadOnlyClobClient();
    const bids = await getBidPriceLevels(tokenId, client);

    if (bids.length === 0) {
        console.log(`No bids found for tokenId: ${tokenId}`);
        process.exit(0);
    }

    console.log(`Top ${Math.min(limit, bids.length)} bids for tokenId: ${tokenId}`);
    console.log('price\t\tsize');

    for (const bid of bids.slice(0, limit)) {
        const price = bid.price.toFixed(4);
        const size = bid.size.toFixed(2);
        console.log(`${price}\t\t${size}`);
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to fetch bids: ${message}`);
    process.exit(1);
}
