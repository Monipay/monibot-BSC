/**
 * MoniBot Worker - Blockchain Module (BSC Router-Based)
 * 
 * This module uses the MoniBotRouter smart contract on BNB Smart Chain.
 * It interacts with USDT (18 decimals on BSC) instead of USDC (6 decimals on Base).
 * 
 * Key Changes for BSC:
 * - Network: BSC Mainnet (Chain ID 56)
 * - Token: USDT (0x55d3...) - 18 Decimals
 * - Router: MoniBotRouter (BSC Deployment)
 * 
 * Architecture:
 * - Users approve MoniBotRouter, NOT the bot's wallet
 * - Contract handles atomic fee splitting
 * - Nonce-based replay protection
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi } from 'viem';
import { bsc } from 'viem/chains'; // CHANGED: Base -> BSC
import { privateKeyToAccount } from 'viem/accounts';

// ============ Configuration ============

// Uses the new BSC environment variables
const MONIBOT_ROUTER_ADDRESS = process.env.MONIBOT_BSC_ROUTER_ADDRESS; 
const USDT_ADDRESS = process.env.USDT_ADDRESS; 

// ============ Clients (RPC failover + retry) ============

const RPC_URLS = [
  process.env.BSC_RPC_URL,
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://binance.llamarpc.com'
].filter(Boolean);

let rpcIndex = 0;

function currentRpc() {
  return RPC_URLS[Math.min(rpcIndex, RPC_URLS.length - 1)];
}

function rotateRpc() {
  if (rpcIndex < RPC_URLS.length - 1) {
    rpcIndex += 1;
    console.log(`  🔁 RPC failover → ${currentRpc()}`);
  }
}

function isRateLimitError(err) {
  const msg = String(err?.message || err);
  return msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('over rate limit');
}

let publicClient = createPublicClient({
  chain: bsc,
  transport: http(currentRpc(), { retryCount: 3, retryDelay: 300 })
});

let walletClient = createWalletClient({
  account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY),
  chain: bsc,
  transport: http(currentRpc(), { retryCount: 3, retryDelay: 300 })
});

function rebuildClients() {
  publicClient = createPublicClient({
    chain: bsc,
    transport: http(currentRpc(), { retryCount: 3, retryDelay: 300 })
  });
  walletClient = createWalletClient({
    account: privateKeyToAccount(process.env.MONIBOT_PRIVATE_KEY),
    chain: bsc,
    transport: http(currentRpc(), { retryCount: 3, retryDelay: 300 })
  });
}

// ============ MoniBotRouter ABI (Router Interface) ============

const moniBotRouterAbi = [
  {
    name: 'executeP2P',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'tweetId', type: 'string' }
    ],
    outputs: [{ name: 'success', type: 'bool' }]
  },
  {
    name: 'executeGrant',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'campaignId', type: 'string' }
    ],
    outputs: [{ name: 'success', type: 'bool' }]
  },
  {
    name: 'getNonce',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    name: 'isTweetUsed',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tweetId', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'isGrantIssued',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'campaignId', type: 'string' },
      { name: 'recipient', type: 'address' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    name: 'calculateFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [
      { name: 'fee', type: 'uint256' },
      { name: 'netAmount', type: 'uint256' }
    ]
  }
];

// ============ Core Functions ============

/**
 * Execute a P2P transfer via the MoniBotRouter contract on BSC
 * Used for social payment commands (e.g., "@monibot send $5 to @alice")
 * 
 * The contract atomically:
 * 1. Transfers (amount - fee) to recipient
 * 2. Transfers fee to platform treasury
 * 3. Increments user's nonce
 * 4. Marks tweetId as used
 * 
 * @param {string} fromAddress - Sender's wallet address
 * @param {string} toAddress - Recipient's wallet address  
 * @param {number} amount - Gross amount in USDT (fee will be deducted by contract)
 * @param {string} tweetId - Tweet ID for deduplication
 * @returns {Promise<{hash: string, fee: number}>} Transaction hash and fee charged
 */
export async function executeP2PViaRouter(fromAddress, toAddress, amount, tweetId) {
  // CHANGED: 18 decimals for USDT on BSC
  const amountInUnits = parseUnits(amount.toFixed(18), 18);
  
  // --- 1. PRE-FLIGHT CHECKS ---
  let nonce, balance, allowance, isTweetUsed;

  const runPreflight = () => Promise.all([
    publicClient.readContract({
      address: MONIBOT_ROUTER_ADDRESS,
      abi: moniBotRouterAbi,
      functionName: 'getNonce',
      args: [fromAddress]
    }),
    publicClient.readContract({
      address: USDT_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [fromAddress]
    }),
    publicClient.readContract({
      address: USDT_ADDRESS,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [fromAddress, MONIBOT_ROUTER_ADDRESS]
    }),
    publicClient.readContract({
      address: MONIBOT_ROUTER_ADDRESS,
      abi: moniBotRouterAbi,
      functionName: 'isTweetUsed',
      args: [tweetId]
    })
  ]);

  try {
    [nonce, balance, allowance, isTweetUsed] = await runPreflight();
  } catch (err) {
    if (isRateLimitError(err)) {
      console.warn('  ⚠️ RPC rate limited during preflight; retrying on fallback RPC...');
      rotateRpc();
      rebuildClients();
      [nonce, balance, allowance, isTweetUsed] = await runPreflight();
    } else {
      throw err;
    }
  }

  console.log(`  🔍 Pre-flight Check for ${fromAddress}:`);
  console.log(`     Nonce: ${nonce}`);
  console.log(`     Balance: ${formatUnits(balance, 18)} USDT`); // CHANGED: 18 decimals
  console.log(`     Allowance (to Router): ${formatUnits(allowance, 18)} USDT`); // CHANGED: 18 decimals
  console.log(`     Amount Requested: ${amount} USDT`);

  // Check if tweet already processed
  if (isTweetUsed) {
    throw new Error('ERROR_DUPLICATE_TWEET');
  }

  // Check balance
  if (balance < amountInUnits) {
    throw new Error(`ERROR_BALANCE:Has ${formatUnits(balance, 18)}, needs ${amount}`);
  }

  // Check allowance (user must approve MoniBotRouter)
  if (allowance < amountInUnits) {
    throw new Error(`ERROR_ALLOWANCE:Approved ${formatUnits(allowance, 18)}, needs ${amount}`);
  }

  // --- 2. CALCULATE FEE (for logging) ---
  const [fee] = await publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'calculateFee',
    args: [amountInUnits]
  });
  const feeAmount = parseFloat(formatUnits(fee, 18)); // CHANGED: 18 decimals
  console.log(`     Fee: ${feeAmount} USDT`);

  // --- 3. EXECUTE VIA ROUTER ---
  console.log(`     🚀 Executing P2P via BSC Router...`);

  // Explicit gas estimation with buffer
  const estimate = async () => publicClient.estimateContractGas({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'executeP2P',
    args: [fromAddress, toAddress, amountInUnits, nonce, tweetId],
    account: walletClient.account?.address,
  });

  let gas;
  try {
    gas = await estimate();
  } catch (err) {
    if (isRateLimitError(err)) {
      console.warn('  ⚠️ RPC rate limited during gas estimate; retrying on fallback RPC...');
      rotateRpc();
      rebuildClients();
      gas = await estimate();
    } else {
      throw err;
    }
  }

  const gasLimit = gas + gas / 5n; // +20% buffer for safety

  const hash = await walletClient.writeContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'executeP2P',
    args: [fromAddress, toAddress, amountInUnits, nonce, tweetId],
    gas: gasLimit,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`     ✅ P2P executed. Hash: ${hash}`);

  return { hash, fee: feeAmount };
}

/**
 * Execute a campaign grant via the MoniBotRouter contract
 * Used for promotional distributions (e.g., "Reply to win $1")
 * 
 * The contract:
 * 1. Transfers (amount - fee) from contract balance to recipient
 * 2. Transfers fee to platform treasury
 * 3. Marks campaignId + recipient as granted (prevents duplicates)
 */
export async function executeGrantViaRouter(toAddress, amount, campaignId) {
  // CHANGED: 18 decimals for USDT on BSC
  const amountInUnits = parseUnits(amount.toFixed(18), 18);

  // --- 1. PRE-FLIGHT CHECKS ---
  let isGrantIssued, contractBalance;

  const runGrantPreflight = () => Promise.all([
    publicClient.readContract({
      address: MONIBOT_ROUTER_ADDRESS,
      abi: moniBotRouterAbi,
      functionName: 'isGrantIssued',
      args: [campaignId, toAddress]
    }),
    publicClient.readContract({
      address: USDT_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [MONIBOT_ROUTER_ADDRESS]
    })
  ]);

  try {
    [isGrantIssued, contractBalance] = await runGrantPreflight();
  } catch (err) {
    if (isRateLimitError(err)) {
      console.warn('  ⚠️ RPC rate limited during grant preflight; retrying on fallback RPC...');
      rotateRpc();
      rebuildClients();
      [isGrantIssued, contractBalance] = await runGrantPreflight();
    } else {
      throw err;
    }
  }

  console.log(`  🔍 Pre-flight Check for Grant:`);
  console.log(`     Recipient: ${toAddress}`);
  console.log(`     Campaign: ${campaignId}`);
  console.log(`     Contract Balance: ${formatUnits(contractBalance, 18)} USDT`);

  // Check if already granted
  if (isGrantIssued) {
    throw new Error('ERROR_DUPLICATE_GRANT');
  }

  // Check contract has enough balance
  if (contractBalance < amountInUnits) {
    throw new Error(`ERROR_CONTRACT_BALANCE:Has ${formatUnits(contractBalance, 18)}, needs ${amount}`);
  }

  // --- 2. CALCULATE FEE (for logging) ---
  const [fee] = await publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'calculateFee',
    args: [amountInUnits]
  });
  const feeAmount = parseFloat(formatUnits(fee, 18)); // CHANGED: 18 decimals
  console.log(`     Fee: ${feeAmount} USDT`);

  // --- 3. EXECUTE VIA ROUTER ---
  console.log(`     🚀 Executing Grant via BSC Router...`);

  const estimate = async () => publicClient.estimateContractGas({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'executeGrant',
    args: [toAddress, amountInUnits, campaignId],
    account: walletClient.account?.address,
  });

  let gas;
  try {
    gas = await estimate();
  } catch (err) {
    if (isRateLimitError(err)) {
      console.warn('  ⚠️ RPC rate limited during gas estimate; retrying on fallback RPC...');
      rotateRpc();
      rebuildClients();
      gas = await estimate();
    } else {
      throw err;
    }
  }

  const gasLimit = gas + gas / 5n; // +20% buffer

  const hash = await walletClient.writeContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'executeGrant',
    args: [toAddress, amountInUnits, campaignId],
    gas: gasLimit,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`     ✅ Grant executed. Hash: ${hash}`);

  return { hash, fee: feeAmount };
}

// ============ View Functions ============

/**
 * Get user's current nonce from the Router contract
 */
export async function getUserNonce(userAddress) {
  return publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'getNonce',
    args: [userAddress]
  });
}

/**
 * Get user's USDT allowance to the MoniBotRouter
 */
export async function getOnchainAllowance(userAddress) {
  const allowance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress, MONIBOT_ROUTER_ADDRESS]
  });
  
  return parseFloat(formatUnits(allowance, 18)); // CHANGED: 18 decimals
}

/**
 * Get user's USDT balance
 * Renamed to getUSDTBalance for clarity, but logic is same
 */
export async function getUSDTBalance(userAddress) {
  const balance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress]
  });
  
  return parseFloat(formatUnits(balance, 18)); // CHANGED: 18 decimals
}

/**
 * Check if a tweet has already been processed
 */
export async function isTweetProcessed(tweetId) {
  return publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'isTweetUsed',
    args: [tweetId]
  });
}

/**
 * Check if a grant has already been issued for a campaign + recipient
 */
export async function isGrantAlreadyIssued(campaignId, recipientAddress) {
  return publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'isGrantIssued',
    args: [campaignId, recipientAddress]
  });
}

/**
 * Calculate fee for a given amount
 */
export async function calculateFee(amount) {
  const amountInUnits = parseUnits(amount.toFixed(18), 18); // CHANGED: 18 decimals
  
  const [fee, netAmount] = await publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'calculateFee',
    args: [amountInUnits]
  });
  
  return {
    fee: parseFloat(formatUnits(fee, 18)),
    netAmount: parseFloat(formatUnits(netAmount, 18))
  };
}

// ============ Exports ============

export { MONIBOT_ROUTER_ADDRESS, USDT_ADDRESS };
