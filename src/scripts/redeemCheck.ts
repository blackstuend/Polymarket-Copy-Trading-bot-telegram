import { getOutcomePayoutRatio, redeemPositionsOnChain } from '../utils/redeem.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const conditionId = args[0];
const outcomeIndexArg = args[1];
const sizeArg = args[2];
const rpcUrl = args[3] || process.env.RPC_URL || '';
const privateKey = args[4] || process.env.PRIVATE_KEY || '';

if (!conditionId || outcomeIndexArg === undefined || sizeArg === undefined) {
    logger.error('Usage: pnpm redeem-check <conditionId> <outcomeIndex> <size> [rpcUrl] [privateKey]');
    logger.error('Env fallback: RPC_URL, PRIVATE_KEY');
    process.exit(1);
}

const outcomeIndex = Number.parseInt(outcomeIndexArg, 10);
const size = Number.parseFloat(sizeArg);

if (!Number.isFinite(outcomeIndex) || outcomeIndex < 0) {
    logger.error('Invalid outcomeIndex. Use a non-negative integer.');
    process.exit(1);
}

if (!Number.isFinite(size) || size <= 0) {
    logger.error('Invalid size. Use a positive number.');
    process.exit(1);
}

if (!rpcUrl) {
    logger.error('Missing rpcUrl. Provide as argument or set RPC_URL.');
    process.exit(1);
}

try {
    const payoutInfo = await getOutcomePayoutRatio(rpcUrl, conditionId, outcomeIndex);

    if (!payoutInfo.settled) {
        const reason = payoutInfo.error || 'Condition not settled';
        logger.info(`Not redeemable yet: ${reason}`);
        process.exit(0);
    }

    const redeemValue = size * payoutInfo.payout;
    logger.info(`Redeemable: yes`);
    logger.info(`Payout ratio: ${payoutInfo.payout.toFixed(6)}`);
    logger.info(`Estimated value: $${redeemValue.toFixed(2)}`);

    if (privateKey) {
        const result = await redeemPositionsOnChain(privateKey, rpcUrl, conditionId);
        if (result.success) {
            logger.info(`Redeem tx: ${result.txHash}`);
            logger.info(`Gas used: ${result.gasUsed}`);
        } else {
            logger.warn(`Redeem failed: ${result.error || 'Unknown error'}`);
            if (result.txHash) {
                logger.info(`Tx hash: ${result.txHash}`);
            }
        }
    } else {
        logger.info('No privateKey provided; skipping on-chain redeem.');
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to check redeem: ${message}`);
    process.exit(1);
}
