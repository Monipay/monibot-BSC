/**
 * MoniBot Worker - Multi-Recipient P2P Module
 * 
 * Handles commands like: "@monibot send $1 each to @jap, @mac, @jake, @dave"
 * 
 * Parses multiple recipients, validates all, executes sequentially,
 * and logs each transaction individually.
 */

import {
  getProfileByMonitag,
  getProfileByXUsername,
  logTransaction,
  syncToMainLedger
} from './database.js';
import {
  executeP2PViaRouter,
  getOnchainAllowance,
  getUSDCBalance,
  calculateFee
} from './blockchain.js';

const MONIBOT_WALLET_ADDRESS = process.env.MONIBOT_WALLET_ADDRESS || '0x...';

/**
 * Detect if a tweet is a multi-recipient command.
 * Patterns:
 *   - "send $X each to @a, @b, @c"
 *   - "send $X to @a, @b, @c"
 *   - "pay @a @b @c $X each"
 */
export function isMultiRecipientCommand(text) {
  const cleaned = text.toLowerCase();
  
  // Must contain send/pay
  if (!cleaned.includes('send') && !cleaned.includes('pay')) return false;
  
  // Extract all @mentions excluding bot
  const mentions = (text.match(/@([a-zA-Z0-9_-]+)/g) || [])
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');
  
  return mentions.length >= 2;
}

/**
 * Parse multi-recipient command.
 * Returns { amount, recipients[] } or null if unparseable.
 */
export function parseMultiRecipientCommand(text) {
  // Extract amount
  const amountMatch = text.match(/\$(\d+\.?\d*)/);
  if (!amountMatch) return null;
  
  const amount = parseFloat(amountMatch[1]);
  if (isNaN(amount) || amount <= 0) return null;
  
  // Extract all recipient mentions (excluding bot)
  const mentions = (text.match(/@([a-zA-Z0-9_-]+)/g) || [])
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');
  
  if (mentions.length < 2) return null;
  
  // Deduplicate recipients
  const uniqueRecipients = [...new Set(mentions)];
  
  return { amount, recipients: uniqueRecipients };
}

/**
 * Execute a multi-recipient P2P batch.
 * 
 * @param {object} params
 * @param {object} params.senderProfile - Sender's profile from DB
 * @param {number} params.amount - Amount per recipient
 * @param {string[]} params.recipientTags - Array of recipient monitags/usernames
 * @param {string} params.tweetId - Original tweet ID
 * @returns {{ results: Array<{tag: string, status: 'success'|'failed', reason?: string, hash?: string}>, summary: object }}
 */
export async function executeMultiRecipientP2P({ senderProfile, amount, recipientTags, tweetId }) {
  const results = [];
  
  // Filter out self-sends
  const filteredTags = recipientTags.filter(tag => {
    if (tag === senderProfile.pay_tag?.toLowerCase() || tag === senderProfile.x_username?.toLowerCase()) {
      results.push({ tag, status: 'failed', reason: 'Cannot send to yourself' });
      return false;
    }
    return true;
  });
  
  if (filteredTags.length === 0) {
    return { results, summary: { total: recipientTags.length, success: 0, failed: results.length } };
  }
  
  const totalNeeded = amount * filteredTags.length;
  
  // 1. Pre-validate balance and allowance for entire batch
  const [balance, allowance] = await Promise.all([
    getUSDCBalance(senderProfile.wallet_address),
    getOnchainAllowance(senderProfile.wallet_address)
  ]);
  
  if (balance < totalNeeded) {
    // Not enough for all — calculate how many we can afford
    const affordableCount = Math.floor(balance / amount);
    if (affordableCount === 0) {
      // Can't afford any
      for (const tag of filteredTags) {
        results.push({ tag, status: 'failed', reason: 'Insufficient balance' });
      }
      return { results, summary: { total: recipientTags.length, success: 0, failed: results.length } };
    }
    // Process only what we can afford, fail the rest
    const skipped = filteredTags.slice(affordableCount);
    for (const tag of skipped) {
      results.push({ tag, status: 'failed', reason: 'Insufficient balance (batch limit)' });
    }
    filteredTags.length = affordableCount;
  }
  
  if (allowance < amount) {
    // Can't afford even one
    for (const tag of filteredTags) {
      results.push({ tag, status: 'failed', reason: 'Insufficient allowance' });
    }
    return { results, summary: { total: recipientTags.length, success: 0, failed: results.length } };
  }
  
  // 2. Resolve all recipient profiles first
  const resolvedRecipients = [];
  for (const tag of filteredTags) {
    const profile = await getProfileByMonitag(tag) || await getProfileByXUsername(tag);
    if (!profile) {
      results.push({ tag, status: 'failed', reason: 'Monitag not found' });
    } else {
      resolvedRecipients.push({ tag, profile });
    }
  }
  
  // 3. Execute one at a time (sequential to avoid nonce conflicts)
  for (const { tag, profile } of resolvedRecipients) {
    try {
      // Use unique tweetId per recipient to avoid on-chain dedup collision
      const uniqueTweetId = `${tweetId}_${tag}`;
      
      const { hash, fee: actualFee } = await executeP2PViaRouter(
        senderProfile.wallet_address,
        profile.wallet_address,
        amount,
        uniqueTweetId
      );
      
      const netAmount = amount - actualFee;
      
      // Log to monibot_transactions
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: profile.id,
        amount: netAmount,
        fee: actualFee,
        tx_hash: hash,
        type: 'p2p_command',
        tweet_id: tweetId, // Same tweet_id for all (different receiver_id)
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: profile.pay_tag
      });
      
      // Sync to main ledger
      await syncToMainLedger({
        senderWalletAddress: senderProfile.wallet_address,
        receiverWalletAddress: profile.wallet_address,
        senderPayTag: senderProfile.pay_tag,
        receiverPayTag: profile.pay_tag,
        amount: netAmount,
        fee: actualFee,
        txHash: hash,
        monibotType: 'p2p',
        tweetId
      });
      
      results.push({ tag: profile.pay_tag || tag, status: 'success', hash });
      console.log(`      ✅ Sent $${amount} to @${tag} (${hash.substring(0, 18)}...)`);
      
    } catch (txError) {
      console.error(`      ❌ Failed for @${tag}:`, txError.message);
      
      let reason = 'Transaction failed';
      if (txError.message.includes('ERROR_BALANCE')) reason = 'Insufficient balance';
      else if (txError.message.includes('ERROR_ALLOWANCE')) reason = 'Insufficient allowance';
      else if (txError.message.includes('ERROR_DUPLICATE')) reason = 'Already processed';
      
      // Log failure
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: profile.id,
        amount,
        fee: 0,
        tx_hash: `ERROR_BATCH_${txError.message.split(':')[0] || 'UNKNOWN'}`,
        type: 'p2p_command',
        tweet_id: tweetId,
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: profile.pay_tag || tag
      });
      
      results.push({ tag, status: 'failed', reason });
      
      // If balance/allowance error, skip remaining (they'll all fail)
      if (reason === 'Insufficient balance' || reason === 'Insufficient allowance') {
        const remaining = resolvedRecipients.slice(resolvedRecipients.indexOf(resolvedRecipients.find(r => r.tag === tag)) + 1);
        for (const r of remaining) {
          results.push({ tag: r.tag, status: 'failed', reason: `${reason} (batch stopped)` });
        }
        break;
      }
    }
  }
  
  const successCount = results.filter(r => r.status === 'success').length;
  const failedCount = results.filter(r => r.status === 'failed').length;
  
  return {
    results,
    summary: {
      total: recipientTags.length,
      success: successCount,
      failed: failedCount
    }
  };
}

/**
 * Build a summary reply text for multi-recipient results.
 */
export function buildMultiRecipientReply(amount, results, summary) {
  const successTags = results.filter(r => r.status === 'success').map(r => `@${r.tag}`);
  const failedEntries = results.filter(r => r.status === 'failed');
  
  if (summary.success === summary.total) {
    // Complete success
    return `Sent $${amount} each to ${successTags.join(', ')} (${summary.success}/${summary.total} successful)`;
  }
  
  if (summary.success === 0) {
    // Complete failure
    const reason = failedEntries[0]?.reason || 'unknown error';
    return `Could not process batch: ${reason} for ${summary.total} recipient${summary.total > 1 ? 's' : ''}`;
  }
  
  // Partial success
  const failedSummary = failedEntries
    .slice(0, 3) // Show max 3 failures to fit tweet
    .map(f => `@${f.tag}: ${f.reason}`)
    .join(', ');
  
  return `Sent $${amount} to ${successTags.join(', ')} (${summary.success}/${summary.total}). Failed: ${failedSummary}`;
}
