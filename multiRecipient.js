/**
 * MoniBot BSC Worker - Multi-Recipient P2P Module
 * 
 * Handles commands like: "@monibot send $1 each to @jap, @mac, @jake, @dave"
 * BSC variant: Uses USDT balance/allowance checks.
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
  getUSDTBalance,
  calculateFee
} from './blockchain.js';

const MONIBOT_WALLET_ADDRESS = process.env.MONIBOT_WALLET_ADDRESS || '0x...';

export function isMultiRecipientCommand(text) {
  const cleaned = text.toLowerCase();
  
  if (!cleaned.includes('send') && !cleaned.includes('pay')) return false;
  
  const mentions = (text.match(/@([a-zA-Z0-9_-]+)/g) || [])
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');
  
  return mentions.length >= 2;
}

export function parseMultiRecipientCommand(text) {
  const amountMatch = text.match(/\$(\d+\.?\d*)/);
  if (!amountMatch) return null;
  
  const amount = parseFloat(amountMatch[1]);
  if (isNaN(amount) || amount <= 0) return null;
  
  const mentions = (text.match(/@([a-zA-Z0-9_-]+)/g) || [])
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');
  
  if (mentions.length < 2) return null;
  
  const uniqueRecipients = [...new Set(mentions)];
  
  return { amount, recipients: uniqueRecipients };
}

export async function executeMultiRecipientP2P({ senderProfile, amount, recipientTags, tweetId }) {
  const results = [];
  
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
  
  const [balance, allowance] = await Promise.all([
    getUSDTBalance(senderProfile.wallet_address),
    getOnchainAllowance(senderProfile.wallet_address)
  ]);
  
  if (balance < totalNeeded) {
    const affordableCount = Math.floor(balance / amount);
    if (affordableCount === 0) {
      for (const tag of filteredTags) {
        results.push({ tag, status: 'failed', reason: 'Insufficient balance' });
      }
      return { results, summary: { total: recipientTags.length, success: 0, failed: results.length } };
    }
    const skipped = filteredTags.slice(affordableCount);
    for (const tag of skipped) {
      results.push({ tag, status: 'failed', reason: 'Insufficient balance (batch limit)' });
    }
    filteredTags.length = affordableCount;
  }
  
  if (allowance < amount) {
    for (const tag of filteredTags) {
      results.push({ tag, status: 'failed', reason: 'Insufficient allowance' });
    }
    return { results, summary: { total: recipientTags.length, success: 0, failed: results.length } };
  }
  
  const resolvedRecipients = [];
  for (const tag of filteredTags) {
    const profile = await getProfileByMonitag(tag) || await getProfileByXUsername(tag);
    if (!profile) {
      results.push({ tag, status: 'failed', reason: 'Monitag not found' });
    } else {
      resolvedRecipients.push({ tag, profile });
    }
  }
  
  for (const { tag, profile } of resolvedRecipients) {
    try {
      const uniqueTweetId = `${tweetId}_${tag}`;
      
      const { hash, fee: actualFee } = await executeP2PViaRouter(
        senderProfile.wallet_address,
        profile.wallet_address,
        amount,
        uniqueTweetId
      );
      
      const netAmount = amount - actualFee;
      
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: profile.id,
        amount: netAmount,
        fee: actualFee,
        tx_hash: hash,
        type: 'p2p_command',
        tweet_id: tweetId,
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: profile.pay_tag
      });
      
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
      console.log(`      ✅ [BSC] Sent $${amount} USDT to @${tag} (${hash.substring(0, 18)}...)`);
      
    } catch (txError) {
      console.error(`      ❌ Failed for @${tag}:`, txError.message);
      
      let reason = 'Transaction failed';
      if (txError.message.includes('ERROR_BALANCE')) reason = 'Insufficient balance';
      else if (txError.message.includes('ERROR_ALLOWANCE')) reason = 'Insufficient allowance';
      else if (txError.message.includes('ERROR_DUPLICATE')) reason = 'Already processed';
      
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

export function buildMultiRecipientReply(amount, results, summary) {
  const successTags = results.filter(r => r.status === 'success').map(r => `@${r.tag}`);
  const failedEntries = results.filter(r => r.status === 'failed');
  
  if (summary.success === summary.total) {
    return `Sent $${amount} USDT each to ${successTags.join(', ')} (${summary.success}/${summary.total} successful)`;
  }
  
  if (summary.success === 0) {
    const reason = failedEntries[0]?.reason || 'unknown error';
    return `Could not process batch: ${reason} for ${summary.total} recipient${summary.total > 1 ? 's' : ''}`;
  }
  
  const failedSummary = failedEntries
    .slice(0, 3)
    .map(f => `@${f.tag}: ${f.reason}`)
    .join(', ');
  
  return `Sent $${amount} USDT to ${successTags.join(', ')} (${summary.success}/${summary.total}). Failed: ${failedSummary}`;
}
