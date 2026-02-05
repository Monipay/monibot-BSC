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
// The official MoniPay fee recipient address
const FEE_RECIPIENT = '0xDC9B47551734bE984D7Aa2a365251E002f8FF2D7';

/**
 * Transfer USDC from MoniBot's wallet (Used for Campaign Grants)
 */
export async function transferUSDC(toAddress, amount) {
  // Fix to 6 decimals for USDC standard
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
 * Transfer USDC using user's allowance (Used for P2P commands)
 * Includes Pre-flight On-chain checks and robust fee handling
 */
export async function transferFromUSDC(fromAddress, toAddress, amount, fee) {
  const amountInUnits = parseUnits(amount.toFixed(6), 6);
  const feeInUnits = parseUnits(fee.toFixed(6), 6);
  const totalInUnits = amountInUnits + feeInUnits;

  // --- 1. PRE-FLIGHT ON-CHAIN CHECK ---
  // We check the blockchain directly before sending the tx to prevent "Execution Reverted" crashes
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

  console.log(`  🔍 Blockchain Verify for ${fromAddress}:`);
  console.log(`     Balance: ${formatUnits(balance, 6)} USDC`);
  console.log(`     Allowance: ${formatUnits(allowance, 6)} USDC`);
  console.log(`     Total Needed: ${formatUnits(totalInUnits, 6)} USDC`);

  if (balance < totalInUnits) {
    throw new Error(`Insufficient Balance: Has ${formatUnits(balance, 6)}, needs ${formatUnits(totalInUnits, 6)}`);
  }

  if (allowance < totalInUnits) {
    throw new Error(`Insufficient Allowance: Approved ${formatUnits(allowance, 6)}, needs ${formatUnits(totalInUnits, 6)}`);
  }

  // --- 2. EXECUTE MAIN PAYMENT ---
  console.log(`     🚀 Step 1: Sending ${amount} USDC to ${toAddress}...`);
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [fromAddress, toAddress, amountInUnits]
  });
  
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`     ✅ Main payment confirmed. Hash: ${hash}`);
  
  // --- 3. EXECUTE FEE PAYMENT ---
  // We use a separate try/catch here so that if the fee fails (gas/nonce), 
  // we don't revert the user's successful main payment.
  if (feeInUnits > 0n) {
    try {
      console.log(`     🚀 Step 2: Sending fee of ${fee} USDC to ${FEE_RECIPIENT}...`);
      const feeHash = await walletClient.writeContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [fromAddress, FEE_RECIPIENT, feeInUnits]
      });
      
      await publicClient.waitForTransactionReceipt({ hash: feeHash });
      console.log(`     ✅ Fee confirmed. Hash: ${feeHash}`);
    } catch (feeError) {
      console.warn(`     ⚠️ Fee Step Failed: ${feeError.message}`);
      // Note: The main transaction is already confirmed, so we continue.
    }
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
