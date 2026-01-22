/**
 * Copy Trading Strategy - Fixed Amount
 */

export interface OrderSizeCalculation {
    fixedAmount: number;
    finalAmount: number;
    reducedByBalance: boolean;
    reasoning: string;
}

/**
 * Calculate order size (fixed amount strategy)
 */
export function calculateOrderSize(
    fixedAmount: number,
    availableBalance: number
): OrderSizeCalculation {
    let finalAmount = fixedAmount;
    let reducedByBalance = false;
    let reasoning = `Fixed amount: $${fixedAmount.toFixed(2)}`;

    // Check available balance (with 1% safety buffer)
    const maxAffordable = availableBalance * 0.99;
    if (finalAmount > maxAffordable) {
        finalAmount = maxAffordable;
        reducedByBalance = true;
        reasoning += ` -> Reduced to fit balance ($${maxAffordable.toFixed(2)})`;
    }

    // Check minimum (if balance too low, skip)
    if (finalAmount < 1) {
        reasoning += ` -> Below minimum $1`;
        finalAmount = 0;
    }

    return {
        fixedAmount,
        finalAmount,
        reducedByBalance,
        reasoning,
    };
}
