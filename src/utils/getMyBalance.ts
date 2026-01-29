import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { USDC_ADDRESS } from './addresses.js';

const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

const getMyBalance = async (address: string): Promise<number> => {
  const rpcUrl = config.polymarket.rpcUrl;
  if (!rpcUrl) {
    throw new Error('RPC_URL is not set');
  }

  const rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
  const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, rpcProvider);
  const balanceUsdc = await usdcContract.balanceOf(address);
  const balanceUsdcReal = ethers.formatUnits(balanceUsdc, 6);
  return parseFloat(balanceUsdcReal);
};

export default getMyBalance;
