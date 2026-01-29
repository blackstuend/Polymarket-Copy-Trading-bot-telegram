import { ethers } from 'ethers';
import { USDC_ADDRESS } from './addresses.js';

export const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

export const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
    'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
];

export const toConditionIdBytes32 = (conditionId: string): string => {
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(conditionId)), 32);
};

export const redeemPositionsOnChain = async (
    privateKey: string,
    rpcUrl: string,
    conditionId: string
): Promise<{ success: boolean; txHash?: string; gasUsed?: string; error?: string }> => {
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const wallet = new ethers.Wallet(privateKey, provider);
        const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);
        const conditionIdBytes32 = toConditionIdBytes32(conditionId);

        const outcomeCount: bigint = await ctfContract.getOutcomeSlotCount(conditionIdBytes32);
        const count = Number(outcomeCount);
        if (!Number.isFinite(count) || count <= 0) {
            return { success: false, error: 'Invalid outcome count' };
        }

        const indexSets = Array.from({ length: count }, (_, i) => 1n << BigInt(i));

        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;

        if (!gasPrice) {
            return { success: false, error: 'Could not determine gas price' };
        }

        const adjustedGasPrice = (gasPrice * 120n) / 100n;

        const tx = await ctfContract.redeemPositions(
            USDC_ADDRESS,
            ethers.ZeroHash,
            conditionIdBytes32,
            indexSets,
            {
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );

        const receipt = await tx.wait();
        if (receipt && receipt.status === 1) {
            return { success: true, txHash: tx.hash, gasUsed: receipt.gasUsed.toString() };
        }

        return { success: false, txHash: tx.hash, error: 'Transaction reverted' };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMessage };
    }
};

export const getOutcomePayoutRatio = async (
    rpcUrl: string,
    conditionId: string,
    outcomeIndex: number
): Promise<{ settled: boolean; payout: number; error?: string }> => {
    try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, provider);
        const conditionIdBytes32 = toConditionIdBytes32(conditionId);

        const denom: bigint = await ctfContract.payoutDenominator(conditionIdBytes32);
        if (denom === 0n) {
            return { settled: false, payout: 0 };
        }

        const outcomeCount: bigint = await ctfContract.getOutcomeSlotCount(conditionIdBytes32);
        const count = Number(outcomeCount);

        if (!Number.isFinite(count) || outcomeIndex < 0 || outcomeIndex >= count) {
            return { settled: false, payout: 0, error: 'Outcome index out of range' };
        }

        const numerator: bigint = await ctfContract.payoutNumerators(conditionIdBytes32, outcomeIndex);
        const payout = Number(numerator) / Number(denom);

        if (!Number.isFinite(payout)) {
            return { settled: false, payout: 0, error: 'Invalid payout ratio' };
        }

        return { settled: true, payout };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { settled: false, payout: 0, error: errorMessage };
    }
};
