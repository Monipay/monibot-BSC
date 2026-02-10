/**
 * MoniBot BSC Worker - Blockchain Module (Router-Based)
 * 
 * BSC variant: Uses USDT (18 decimals) on BNB Smart Chain (Chain ID 56).
 * The bot's wallet is an authorized EXECUTOR on the MoniBotRouter contract.
 * 
 * Key Differences from Base Worker:
 * - Chain: BSC Mainnet (56) instead of Base (8453)
 * - Token: USDT instead of USDC
 * - Decimals: 18 instead of 6
 * - Router: 0x9EED... instead of 0xBEE3...
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi } from 'viem';
import { bsc } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ============ Configuration ============

const MONIBOT_ROUTER_ADDRESS = '0x9EED3cF32690FfFaD0b8BB44CaC65B3B801c832E';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const TOKEN_DECIMALS = 18;

// ============ Clients (RPC failover + retry) ============

const RPC_URLS = [
  process.env.BSC_RPC_URL,
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
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

// ============ MoniBotRouter ABI (Partial) ============

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
 */
export async function executeP2PViaRouter(fromAddress, toAddress, amount, tweetId) {
  const amountInUnits = parseUnits(amount.toFixed(18), TOKEN_DECIMALS);
  
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
      ;[nonce, balance, allowance, isTweetUsed] = await runPreflight();
    } else {
      throw err;
    }
  }

  console.log(`  🔍 Pre-flight Check for ${fromAddress}:`);
  console.log(`     Nonce: ${nonce}`);
  console.log(`     Balance: ${formatUnits(balance, TOKEN_DECIMALS)} USDT`);
  console.log(`     Allowance (to Router): ${formatUnits(allowance, TOKEN_DECIMALS)} USDT`);
  console.log(`     Amount Requested: ${amount} USDT`);

  if (isTweetUsed) {
    throw new Error('ERROR_DUPLICATE_TWEET');
  }

  if (balance < amountInUnits) {
    throw new Error(`ERROR_BALANCE:Has ${formatUnits(balance, TOKEN_DECIMALS)}, needs ${amount}`);
  }

  if (allowance < amountInUnits) {
    throw new Error(`ERROR_ALLOWANCE:Approved ${formatUnits(allowance, TOKEN_DECIMALS)}, needs ${amount}`);
  }

  // --- 2. CALCULATE FEE (for logging) ---
  const [fee] = await publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'calculateFee',
    args: [amountInUnits]
  });
  const feeAmount = parseFloat(formatUnits(fee, TOKEN_DECIMALS));
  console.log(`     Fee: ${feeAmount} USDT`);

  // --- 3. EXECUTE VIA ROUTER ---
  console.log(`     🚀 Executing P2P via Router (BSC)...`);

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

  const gasLimit = gas + gas / 5n; // +20% buffer

  const hash = await walletClient.writeContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'executeP2P',
    args: [fromAddress, toAddress, amountInUnits, nonce, tweetId],
    gas: gasLimit,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`     ✅ P2P executed on BSC. Hash: ${hash}`);

  return { hash, fee: feeAmount };
}

/**
 * Execute a campaign grant via the MoniBotRouter contract on BSC
 */
export async function executeGrantViaRouter(toAddress, amount, campaignId) {
  const amountInUnits = parseUnits(amount.toFixed(18), TOKEN_DECIMALS);

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
      ;[isGrantIssued, contractBalance] = await runGrantPreflight();
    } else {
      throw err;
    }
  }

  console.log(`  🔍 Pre-flight Check for Grant (BSC):`);
  console.log(`     Recipient: ${toAddress}`);
  console.log(`     Campaign: ${campaignId}`);
  console.log(`     Contract Balance: ${formatUnits(contractBalance, TOKEN_DECIMALS)} USDT`);

  if (isGrantIssued) {
    throw new Error('ERROR_DUPLICATE_GRANT');
  }

  if (contractBalance < amountInUnits) {
    throw new Error(`ERROR_CONTRACT_BALANCE:Has ${formatUnits(contractBalance, TOKEN_DECIMALS)}, needs ${amount}`);
  }

  // --- 2. CALCULATE FEE (for logging) ---
  const [fee] = await publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'calculateFee',
    args: [amountInUnits]
  });
  const feeAmount = parseFloat(formatUnits(fee, TOKEN_DECIMALS));
  console.log(`     Fee: ${feeAmount} USDT`);

  // --- 3. EXECUTE VIA ROUTER ---
  console.log(`     🚀 Executing Grant via Router (BSC)...`);

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
  console.log(`     ✅ Grant executed on BSC. Hash: ${hash}`);

  return { hash, fee: feeAmount };
}

// ============ View Functions ============

export async function getUserNonce(userAddress) {
  return publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'getNonce',
    args: [userAddress]
  });
}

export async function getOnchainAllowance(userAddress) {
  const allowance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress, MONIBOT_ROUTER_ADDRESS]
  });
  
  return parseFloat(formatUnits(allowance, TOKEN_DECIMALS));
}

export async function getUSDTBalance(userAddress) {
  const balance = await publicClient.readContract({
    address: USDT_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [userAddress]
  });
  
  return parseFloat(formatUnits(balance, TOKEN_DECIMALS));
}

export async function isTweetProcessed(tweetId) {
  return publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'isTweetUsed',
    args: [tweetId]
  });
}

export async function isGrantAlreadyIssued(campaignId, recipientAddress) {
  return publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'isGrantIssued',
    args: [campaignId, recipientAddress]
  });
}

export async function calculateFee(amount) {
  const amountInUnits = parseUnits(amount.toFixed(18), TOKEN_DECIMALS);
  
  const [fee, netAmount] = await publicClient.readContract({
    address: MONIBOT_ROUTER_ADDRESS,
    abi: moniBotRouterAbi,
    functionName: 'calculateFee',
    args: [amountInUnits]
  });
  
  return {
    fee: parseFloat(formatUnits(fee, TOKEN_DECIMALS)),
    netAmount: parseFloat(formatUnits(netAmount, TOKEN_DECIMALS))
  };
}

// ============ Exports ============

export { MONIBOT_ROUTER_ADDRESS, USDT_ADDRESS };
