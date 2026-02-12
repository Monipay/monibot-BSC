/**
 * MoniBot BSC Worker - Cross-Chain Balance Check
 * 
 * Lightweight read-only module to check Base balances/allowances.
 * Used for balance-aware routing: if BSC has insufficient funds,
 * check if Base can handle the transaction before failing.
 */

import { createPublicClient, http, formatUnits, erc20Abi } from 'viem';
import { base } from 'viem/chains';

// Base constants (from chains.ts config)
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_MONIBOT_ROUTER = '0xBEE37c2f3Ce9a48D498FC0D47629a1E10356A516';
const BASE_TOKEN_DECIMALS = 6;

const BASE_RPC_URLS = [
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
  'https://mainnet.base.org',
];

let baseClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URLS[0], { retryCount: 2, retryDelay: 500 })
});

/**
 * Check if a user has sufficient USDC balance AND allowance on Base
 * to handle a P2P transfer of the given amount.
 * 
 * @param {string} walletAddress - User's wallet address
 * @param {number} amount - Amount needed (in human-readable units)
 * @returns {Promise<{hasBalance: boolean, hasAllowance: boolean, balance: number, allowance: number}>}
 */
export async function checkBaseFunds(walletAddress, amount) {
  try {
    const [balance, allowance] = await Promise.all([
      baseClient.readContract({
        address: BASE_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [walletAddress]
      }),
      baseClient.readContract({
        address: BASE_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [walletAddress, BASE_MONIBOT_ROUTER]
      })
    ]);

    const balanceNum = parseFloat(formatUnits(balance, BASE_TOKEN_DECIMALS));
    const allowanceNum = parseFloat(formatUnits(allowance, BASE_TOKEN_DECIMALS));

    return {
      hasBalance: balanceNum >= amount,
      hasAllowance: allowanceNum >= amount,
      balance: balanceNum,
      allowance: allowanceNum,
      chain: 'base'
    };
  } catch (error) {
    console.warn(`  ⚠️ Cross-chain Base check failed: ${error.message}`);
    try {
      baseClient = createPublicClient({
        chain: base,
        transport: http(BASE_RPC_URLS[1], { retryCount: 2, retryDelay: 500 })
      });
      
      const [balance, allowance] = await Promise.all([
        baseClient.readContract({
          address: BASE_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [walletAddress]
        }),
        baseClient.readContract({
          address: BASE_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [walletAddress, BASE_MONIBOT_ROUTER]
        })
      ]);

      const balanceNum = parseFloat(formatUnits(balance, BASE_TOKEN_DECIMALS));
      const allowanceNum = parseFloat(formatUnits(allowance, BASE_TOKEN_DECIMALS));

      return {
        hasBalance: balanceNum >= amount,
        hasAllowance: allowanceNum >= amount,
        balance: balanceNum,
        allowance: allowanceNum,
        chain: 'base'
      };
    } catch (retryError) {
      console.warn(`  ⚠️ Cross-chain Base check failed on retry: ${retryError.message}`);
      return { hasBalance: false, hasAllowance: false, balance: 0, allowance: 0, chain: 'base' };
    }
  }
}
