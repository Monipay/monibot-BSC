import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL)
});

const walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY),
  chain: base,
  transport: http(process.env.BASE_RPC_URL)
});

const USDC_ADDRESS = process.env.USDC_ADDRESS;

/**
 * Transfer USDC from MoniBot's wallet (for Campaign Grants)
 */
export async function transferUSDC(toAddress, amount) {
  const amountInUnits = parseUnits(amount.toFixed(6), 6);
  
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [toAddress, amountInUnits]
  });
  
  await publicClient.waitForTransactionReceipt({ hash });
  
  return hash;
}

/**
 * Transfer USDC using user's allowance (for P2P commands)
 * Includes Pre-flight Balance and Allowance checks
 */
export async function transferFromUSDC(fromAddress, toAddress, amount, fee) {
  const amountInUnits = parseUnits(amount.toFixed(6), 6);
  const feeInUnits = parseUnits(fee.toFixed(6), 6);
  const totalInUnits = amountInUnits + feeInUnits;

  // --- ON-CHAIN PRE-FLIGHT CHECK ---
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [fromAddress]
    }),
    publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [fromAddress, process.env.MONIBOT_WALLET_ADDRESS]
    })
  ]);

  console.log(`  🔍 On-chain Check for ${fromAddress}:`);
  console.log(`     Balance: ${formatUnits(balance, 6)} USDC`);
  console.log(`     Allowance: ${formatUnits(allowance, 6)} USDC`);
  console.log(`     Needed: ${formatUnits(totalInUnits, 6)} USDC`);

  if (balance < totalInUnits) {
    throw new Error(`Insufficient Balance: User has ${formatUnits(balance, 6)}`);
  }

  if (allowance < totalInUnits) {
    throw new Error(`Insufficient Allowance: User approved ${formatUnits(allowance, 6)}`);
  }

  // --- EXECUTION ---
  
  // 1. Transfer Net Amount to Recipient
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [fromAddress, toAddress, amountInUnits]
  });
  
  await publicClient.waitForTransactionReceipt({ hash });
  
  // 2. Transfer Fee to MoniBot
  if (feeInUnits > 0n) {
    const feeHash = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'transferFrom',
      args: [fromAddress, process.env.MONIBOT_WALLET_ADDRESS, feeInUnits]
    });
    
    await publicClient.waitForTransactionReceipt({ hash: feeHash });
  }
  
  return hash;
}

/**
 * Get user's on-chain allowance for MoniBot
 */
export async function getOnchainAllowance(userAddress) {
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress, process.env.MONIBOT_WALLET_ADDRESS]
  });
  
  return parseFloat(formatUnits(allowance, 6));
}
