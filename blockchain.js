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

// Transfer USDC from MoniBot wallet (for grants)
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

// Transfer USDC using user's allowance (for P2P commands)
export async function transferFromUSDC(fromAddress, toAddress, amount, fee) {
  const amountInUnits = parseUnits(amount.toFixed(6), 6);
  const feeInUnits = parseUnits(fee.toFixed(6), 6);
  const totalInUnits = amountInUnits + feeInUnits;
  
  // Transfer to recipient
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [fromAddress, toAddress, amountInUnits]
  });
  
  await publicClient.waitForTransactionReceipt({ hash });
  
  // Transfer fee to MoniBot
  if (fee > 0) {
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

// Get user's onchain allowance for MoniBot
export async function getOnchainAllowance(userAddress) {
  const allowance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress, process.env.MONIBOT_WALLET_ADDRESS]
  });
  
  return parseFloat(formatUnits(allowance, 6));
}