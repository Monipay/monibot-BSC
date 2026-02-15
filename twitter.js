/**
 * MoniBot BSC Worker - Twitter Module (Silent Worker Mode)
 * 
 * BSC variant of the Silent Worker.
 * - Campaigns: Processes ONLY campaigns with network='bsc' (no keyword filter on replies)
 * - P2P: Only processes tweets with BSC keywords (usdt/bnb/bsc/binance)
 * - All transactions logged with chain='BSC' via database.js
 */

import { TwitterApi } from 'twitter-api-v2';
import { 
  getProfileByXUsername, 
  getProfileByMonitag, 
  checkIfAlreadyGranted,
  checkIfCommandProcessed,
  markAsGranted,
  logTransaction,
  getCampaignByTweetId,
  incrementCampaignParticipants,
  getActiveCampaigns,
  syncToMainLedger
} from './database.js';
import { 
  executeP2PViaRouter, 
  executeGrantViaRouter, 
  getOnchainAllowance,
  getUSDTBalance,
  isTweetProcessed,
  isGrantAlreadyIssued,
  calculateFee,
  MONIBOT_ROUTER_ADDRESS
} from './blockchain.js';
import {
  isMultiRecipientCommand,
  parseMultiRecipientCommand,
  executeMultiRecipientP2P,
  buildMultiRecipientReply
} from './multiRecipient.js';
import { checkBaseFunds } from './crossChainCheck.js';
import { createScheduledJob } from './scheduler.js';

let twitterClient;
let lastProcessedTweetId = null;

const MONIBOT_WALLET_ADDRESS = process.env.MONIBOT_WALLET_ADDRESS || '0x...';

// ============ Initialization ============

export function initTwitterClient() {
  twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
  
  console.log('✅ Twitter client initialized (Silent Worker Mode - BSC Router)');
}

// ============ BSC Keyword Detection (P2P only) ============

const BSC_KEYWORDS = ['usdt', 'bnb', 'bsc', 'binance smart chain', 'binance'];

function isBscRelated(text) {
  const lower = text.toLowerCase();
  return BSC_KEYWORDS.some(kw => lower.includes(kw));
}

// ============ Utility Functions ============

function extractFirstPayTag(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const filtered = matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');
  
  return filtered.length > 0 ? filtered[0] : null;
}

function extractPayTags(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay'); 
}

// ============ Loop 1: Campaign Replies (DB-Driven, Network-Filtered) ============

/**
 * Fetches active BSC campaigns from DB and searches for replies.
 * NO keyword filter on replies — any valid monitag gets a grant.
 * Network routing is handled by the campaigns.network column.
 */
export async function pollCampaigns() {
  try {
    console.log('📊 [BSC] Polling for campaign replies...');
    
    // getActiveCampaigns() already filters by network='bsc'
    const activeCampaigns = await getActiveCampaigns();
    
    if (!activeCampaigns || activeCampaigns.length === 0) {
      console.log('   No active BSC campaigns found.');
      return;
    }
    
    console.log(`   Found ${activeCampaigns.length} active BSC campaign(s)`);
    
    for (const campaign of activeCampaigns) {
      if (campaign.current_participants >= (campaign.max_participants || 999999)) {
        console.log(`   ⏭️ Campaign ${campaign.id.substring(0, 8)} already at max participants`);
        continue;
      }
      
      if (!campaign.tweet_id) {
        console.log(`   ⏭️ Campaign ${campaign.id.substring(0, 8)} has no tweet_id`);
        continue;
      }
      
      await processCampaignReplies(campaign);
    }
  } catch (error) {
    console.error('❌ Error polling campaigns:', error.message);
    console.error('   Full error:', error);
  }
}

async function processCampaignReplies(campaign) {
  try {
    console.log(`\n🔍 [BSC] Checking campaign: ${campaign.tweet_id}`);
    console.log(`   Grant: $${campaign.grant_amount} USDT | ${campaign.current_participants || 0}/${campaign.max_participants || '∞'} participants`);
    
    const replies = await twitterClient.v2.search({
      query: `conversation_id:${campaign.tweet_id} -from:monibot`,
      max_results: 100,
      'tweet.fields': ['author_id', 'created_at'],
      'user.fields': ['username'],
      expansions: ['author_id']
    });
    
    if (!replies.data?.data) {
      console.log('   No replies found.');
      return;
    }
    
    console.log(`   Found ${replies.data.data.length} replies to process`);
    
    for (const reply of replies.data.data) {
      const author = replies.includes?.users?.find(u => u.id === reply.author_id);
      if (!author) continue;
      
      await processReply(reply, author, campaign);
    }
  } catch (error) {
    console.error(`❌ Error processing campaign ${campaign.tweet_id}:`, error.message);
  }
}

async function processReply(reply, author, campaign) {
  try {
    const alreadyHandled = await checkIfCommandProcessed(reply.id);
    if (alreadyHandled) return;

    console.log(`\n📝 [BSC] Processing reply from @${author.username}: "${reply.text.substring(0, 50)}..."`);
    
    // NO BSC keyword filter for campaigns!
    // Network routing is handled by campaigns.network='bsc' column.
    // Any valid monitag reply gets a grant.
    
    const targetPayTag = extractFirstPayTag(reply.text);
    if (!targetPayTag) {
      console.log('   ⏭️ No valid pay tags found, logging skip.');
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_NO_PAYTAG',
        campaign_id: campaign.tweet_id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: null
      });
      return;
    }
    
    console.log(`   🎯 Target PayTag: @${targetPayTag}`);
    await processGrantForPayTag(targetPayTag, reply, author, campaign);
  } catch (error) {
    console.error('❌ Error in processReply:', error.message);
  }
}

async function processGrantForPayTag(payTag, reply, author, campaign) {
  try {
    console.log(`   💎 [BSC] Processing grant for @${payTag}...`);
    
    const targetProfile = await getProfileByMonitag(payTag);
    if (!targetProfile) {
      console.log(`      ⏭️ Tag @${payTag} not found in database.`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0, 
        fee: 0, 
        tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'grant', 
        tweet_id: reply.id, 
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: payTag
      });
      return;
    }

    const currentCampaign = await getCampaignByTweetId(campaign.tweet_id);
    if (!currentCampaign) {
      console.log(`      ⏭️ Campaign not found or no longer active`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_CAMPAIGN_INACTIVE',
        campaign_id: campaign.tweet_id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: targetProfile.pay_tag
      });
      return;
    }

    const grantAmount = currentCampaign.grant_amount;
    const maxParticipants = currentCampaign.max_participants || 999999;
    const currentParticipants = currentCampaign.current_participants || 0;

    if (currentParticipants >= maxParticipants) {
      console.log(`      ⏰ Limit reached! Too late for @${payTag}`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0, 
        fee: 0, 
        tx_hash: 'LIMIT_REACHED',
        campaign_id: campaign.tweet_id,
        type: 'grant', 
        tweet_id: reply.id, 
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: targetProfile.pay_tag
      });
      return;
    }

    const alreadyGrantedDB = await checkIfAlreadyGranted(campaign.tweet_id, targetProfile.id);
    if (alreadyGrantedDB) {
      console.log(`      ⏭️ Grant already issued to ${payTag} for this campaign (DB).`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_DUPLICATE_GRANT_DB',
        campaign_id: campaign.tweet_id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: targetProfile.pay_tag
      });
      return;
    }

    const alreadyGrantedOnChain = await isGrantAlreadyIssued(campaign.tweet_id, targetProfile.wallet_address);
    if (alreadyGrantedOnChain) {
      console.log(`      ⏭️ Grant already issued on-chain, syncing DB...`);
      await markAsGranted(campaign.tweet_id, targetProfile.id);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_DUPLICATE_GRANT_ONCHAIN',
        campaign_id: campaign.tweet_id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: targetProfile.pay_tag
      });
      return;
    }

    const { fee, netAmount } = await calculateFee(grantAmount);
    console.log(`      💰 Grant: $${grantAmount} USDT (Net: $${netAmount}, Fee: $${fee})`);

    console.log(`      💸 Executing grant via Router (BSC)...`);
    
    try {
      const { hash, fee: actualFee } = await executeGrantViaRouter(
        targetProfile.wallet_address,
        grantAmount,
        campaign.tweet_id
      );
      
      const netAmountReceived = grantAmount - actualFee;
      
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: netAmountReceived,
        fee: actualFee,
        tx_hash: hash,
        campaign_id: campaign.tweet_id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: targetProfile.pay_tag
      });
      
      await markAsGranted(campaign.tweet_id, targetProfile.id);
      await incrementCampaignParticipants(campaign.tweet_id, grantAmount);
      
      await syncToMainLedger({
        senderWalletAddress: MONIBOT_WALLET_ADDRESS,
        receiverWalletAddress: targetProfile.wallet_address,
        senderPayTag: 'MoniBot',
        receiverPayTag: targetProfile.pay_tag,
        amount: netAmountReceived,
        fee: actualFee,
        txHash: hash,
        monibotType: 'grant',
        tweetId: reply.id,
        campaignId: campaign.tweet_id,
        campaignName: campaign.message?.substring(0, 50) || 'MoniBot BSC Campaign'
      });
      
      console.log(`      ✅ Grant Success on BSC! TX: ${hash}`);
      
    } catch (txError) {
      console.error(`      ❌ Router Error:`, txError.message);
      
      let errorCode = 'ERROR_BLOCKCHAIN';
      if (txError.message.includes('ERROR_DUPLICATE_GRANT')) {
        errorCode = 'ERROR_DUPLICATE_GRANT';
      } else if (txError.message.includes('ERROR_CONTRACT_BALANCE') || txError.message.includes('insufficient')) {
        errorCode = 'ERROR_TREASURY_EMPTY';
      }
      
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0, 
        fee: 0, 
        tx_hash: errorCode,
        type: 'grant', 
        tweet_id: reply.id, 
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: targetProfile.pay_tag
      });
    }
  } catch (error) {
    console.error(`❌ Error processing grant for @${payTag}:`, error.message);
  }
}

// ============ Loop 2: P2P Commands (BSC Keywords Required) ============

export async function pollCommands() {
  try {
    console.log('💬 [BSC] Polling for P2P commands...');
    
    const searchParams = {
      query: '@monibot (send OR pay) (usdt OR bnb OR bsc OR binance) -is:retweet',
      max_results: 50,
      'tweet.fields': ['author_id', 'created_at', 'referenced_tweets'],
      'user.fields': ['username'],
      expansions: ['author_id']
    };

    if (lastProcessedTweetId) {
      searchParams.since_id = lastProcessedTweetId;
    }

    const mentions = await twitterClient.v2.search(searchParams);
    
    if (!mentions.data?.data) {
      console.log('   No new command mentions found.');
      return;
    }
    
    console.log(`🔎 Found ${mentions.data.data.length} potential commands.`);
    lastProcessedTweetId = mentions.data.meta.newest_id;
    
    for (const tweet of mentions.data.data) {
      const author = mentions.includes?.users?.find(u => u.id === tweet.author_id);
      if (author) await processP2PCommand(tweet, author);
    }
  } catch (error) {
    console.error('❌ Error polling commands:', error.message);
  }
}

async function processP2PCommand(tweet, author) {
  try {
    const alreadyHandled = await checkIfCommandProcessed(tweet.id);
    if (alreadyHandled) return;

    // Smart Command Detection: If this is a quote tweet, only process if
    // the author's own text contains a direct command pattern
    const isQuote = tweet.referenced_tweets?.some(r => r.type === 'quoted');
    if (isQuote) {
      const hasDirectCommand = /(?:send\s+\$?\d|pay\s+@?\w+\s+\$?\d)/i.test(tweet.text);
      if (!hasDirectCommand) {
        console.log(`   ⏭️ Quote tweet is discussion/announcement, not a command. Skipping.`);
        await logTransaction({
          sender_id: process.env.MONIBOT_PROFILE_ID,
          receiver_id: process.env.MONIBOT_PROFILE_ID,
          amount: 0,
          fee: 0,
          tx_hash: 'SKIP_QUOTE_NOT_COMMAND',
          type: 'p2p_command',
          tweet_id: tweet.id,
          payer_pay_tag: author.username,
          recipient_pay_tag: null
        });
        return;
      }
    }

    const tweetAlreadyOnChain = await isTweetProcessed(tweet.id);
    if (tweetAlreadyOnChain) {
      console.log(`   ⏭️ Tweet ${tweet.id} already processed on-chain, logging to DB...`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_ALREADY_ONCHAIN',
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: author.username,
        recipient_pay_tag: null
      });
      return;
    }

    console.log(`\n⚡ [BSC] Processing P2P command from @${author.username}`);

    // Skip Tempo-tagged tweets — Tempo bot handles those
    const TEMPO_KEYWORDS = ['on tempo', 'tempo', 'alphausd', 'αusd'];
    const isTempoRelated = TEMPO_KEYWORDS.some(kw => tweet.text.toLowerCase().includes(kw));
    if (isTempoRelated) {
      console.log(`   ⏭️ SKIP_TEMPO_NETWORK: Tempo keywords detected, deferring to Tempo worker.`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_TEMPO_NETWORK',
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: author.username,
        recipient_pay_tag: null
      });
      return;
    }
    
    // === Multi-Recipient Detection ===
    if (isMultiRecipientCommand(tweet.text)) {
      const parsed = parseMultiRecipientCommand(tweet.text);
      if (parsed) {
        console.log(`   📦 Multi-recipient: $${parsed.amount} each to ${parsed.recipients.length} recipients`);
        
        const senderProfile = await getProfileByXUsername(author.username);
        if (!senderProfile) {
          console.log(`   ❌ Sender @${author.username} not found, logging skip.`);
          await logTransaction({
            sender_id: process.env.MONIBOT_PROFILE_ID,
            receiver_id: process.env.MONIBOT_PROFILE_ID,
            amount: parsed.amount * parsed.recipients.length,
            fee: 0,
            tx_hash: 'ERROR_SENDER_NOT_FOUND',
            type: 'p2p_command',
            tweet_id: tweet.id,
            payer_pay_tag: author.username,
            recipient_pay_tag: parsed.recipients.join(',')
          });
          return;
        }
        
        const { results, summary } = await executeMultiRecipientP2P({
          senderProfile,
          amount: parsed.amount,
          recipientTags: parsed.recipients,
          tweetId: tweet.id
        });
        
        console.log(`   📊 Batch result: ${summary.success}/${summary.total} successful`);
        
        if (summary.success === 0 && results.every(r => !r.hash)) {
          const reason = results[0]?.reason || 'unknown';
          await logTransaction({
            sender_id: senderProfile.id,
            receiver_id: senderProfile.id,
            amount: parsed.amount * parsed.recipients.length,
            fee: 0,
            tx_hash: `ERROR_BATCH_${reason.toUpperCase().replace(/\s+/g, '_')}`,
            type: 'p2p_command',
            tweet_id: tweet.id,
            payer_pay_tag: senderProfile.pay_tag,
            recipient_pay_tag: parsed.recipients.join(','),
            status: 'failed'
          });
        }
        
        return;
      }
    }
    
    // === Single Recipient ===
    
    const sendMatch = tweet.text.match(/send\s+\$?(\d+\.?\d*)\s*(?:usdt|usdc|bnb|bsc)?\s+to\s+@?([a-zA-Z0-9_-]+)/i);
    const payMatch = tweet.text.match(/pay\s+@?([a-zA-Z0-9_-]+)\s+\$?(\d+\.?\d*)\s*(?:usdt|usdc|bnb|bsc)?/i);
    
    let amount, targetPayTag;
    
    if (sendMatch) {
      amount = parseFloat(sendMatch[1]);
      targetPayTag = sendMatch[2].toLowerCase();
    } else if (payMatch) {
      amount = parseFloat(payMatch[2]);
      targetPayTag = payMatch[1].toLowerCase();
    } else {
      console.log('   ⏭️ Could not parse command syntax, logging skip.');
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0,
        fee: 0,
        tx_hash: 'SKIP_INVALID_SYNTAX',
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: author.username,
        recipient_pay_tag: null
      });
      return;
    }
    
    console.log(`   💰 Amount: $${amount} USDT | Target: @${targetPayTag}`);

    const senderProfile = await getProfileByXUsername(author.username);
    if (!senderProfile) {
      console.log(`   ❌ Sender @${author.username} not found/verified, logging skip.`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: amount,
        fee: 0,
        tx_hash: 'ERROR_SENDER_NOT_FOUND',
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: author.username,
        recipient_pay_tag: targetPayTag
      });
      return;
    }
    
    const { fee, netAmount } = await calculateFee(amount);
    console.log(`   📊 Gross: $${amount} | Net: $${netAmount} | Fee: $${fee} USDT`);

    const allowance = await getOnchainAllowance(senderProfile.wallet_address);
    if (allowance < amount) {
      console.log(`   ❌ Insufficient Allowance on BSC: Need $${amount}, approved $${allowance}`);
      
      // === Balance-Aware Routing: Check Base ===
      const baseCheck = await checkBaseFunds(senderProfile.wallet_address, amount);
      if (baseCheck.hasBalance && baseCheck.hasAllowance) {
        console.log(`   🔀 Cross-chain routing: Base has $${baseCheck.balance} USDC, allowance $${baseCheck.allowance}. Deferring to Base worker.`);
        await createScheduledJob({
          type: 'cross_chain_p2p',
          scheduledAt: new Date(),
          payload: {
            chain: 'base',
            senderProfileId: senderProfile.id,
            senderWalletAddress: senderProfile.wallet_address,
            senderPayTag: senderProfile.pay_tag,
            targetPayTag,
            amount,
            originalChain: 'bsc',
            reason: 'allowance'
          },
          sourceTweetId: tweet.id,
          sourceAuthorId: author.id,
          sourceAuthorUsername: author.username
        });
        await logTransaction({
          sender_id: senderProfile.id,
          receiver_id: senderProfile.id,
          amount: 0,
          fee: 0,
          tx_hash: 'DEFERRED_TO_BASE',
          type: 'p2p_command',
          tweet_id: tweet.id,
          payer_pay_tag: senderProfile.pay_tag,
          recipient_pay_tag: targetPayTag
        });
        return;
      }
      
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, 
        fee: fee, 
        tx_hash: 'ERROR_ALLOWANCE',
        type: 'p2p_command', 
        tweet_id: tweet.id, 
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: targetPayTag
      });
      return;
    }

    const balance = await getUSDTBalance(senderProfile.wallet_address);
    if (balance < amount) {
      console.log(`   ❌ Insufficient Balance on BSC: Need $${amount}, have $${balance}`);
      
      // === Balance-Aware Routing: Check Base ===
      const baseCheck2 = await checkBaseFunds(senderProfile.wallet_address, amount);
      if (baseCheck2.hasBalance && baseCheck2.hasAllowance) {
        console.log(`   🔀 Cross-chain routing: Base has $${baseCheck2.balance} USDC, allowance $${baseCheck2.allowance}. Deferring to Base worker.`);
        await createScheduledJob({
          type: 'cross_chain_p2p',
          scheduledAt: new Date(),
          payload: {
            chain: 'base',
            senderProfileId: senderProfile.id,
            senderWalletAddress: senderProfile.wallet_address,
            senderPayTag: senderProfile.pay_tag,
            targetPayTag,
            amount,
            originalChain: 'bsc',
            reason: 'balance'
          },
          sourceTweetId: tweet.id,
          sourceAuthorId: author.id,
          sourceAuthorUsername: author.username
        });
        await logTransaction({
          sender_id: senderProfile.id,
          receiver_id: senderProfile.id,
          amount: 0,
          fee: 0,
          tx_hash: 'DEFERRED_TO_BASE',
          type: 'p2p_command',
          tweet_id: tweet.id,
          payer_pay_tag: senderProfile.pay_tag,
          recipient_pay_tag: targetPayTag
        });
        return;
      }
      
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, 
        fee: fee, 
        tx_hash: 'ERROR_BALANCE',
        type: 'p2p_command', 
        tweet_id: tweet.id, 
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: targetPayTag
      });
      return;
    }
    
    let receiverProfile = await getProfileByMonitag(targetPayTag) || await getProfileByXUsername(targetPayTag);
    if (!receiverProfile) {
      console.log(`   ❌ Target @${targetPayTag} not found in MoniPay.`);
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, 
        fee: fee, 
        tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'p2p_command', 
        tweet_id: tweet.id, 
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: targetPayTag
      });
      return;
    }
    
    console.log(`   💸 Executing P2P on BSC: ${senderProfile.pay_tag} -> ${targetPayTag}`);
    
    try {
      const { hash, fee: actualFee } = await executeP2PViaRouter(
        senderProfile.wallet_address,
        receiverProfile.wallet_address,
        amount,
        tweet.id
      );

      const netAmountReceived = amount - actualFee;

      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: receiverProfile.id,
        amount: netAmountReceived,
        fee: actualFee,
        tx_hash: hash,
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: receiverProfile.pay_tag
      });
      
      await syncToMainLedger({
        senderWalletAddress: senderProfile.wallet_address,
        receiverWalletAddress: receiverProfile.wallet_address,
        senderPayTag: senderProfile.pay_tag,
        receiverPayTag: receiverProfile.pay_tag,
        amount: netAmountReceived,
        fee: actualFee,
        txHash: hash,
        monibotType: 'p2p',
        tweetId: tweet.id
      });
      
      console.log(`   ✅ P2P Success on BSC! TX: ${hash}`);
      
    } catch (txError) {
      console.error(`   ❌ Router Error:`, txError.message);
      
      let errorCode = 'ERROR_BLOCKCHAIN';
      if (txError.message.includes('ERROR_DUPLICATE_TWEET')) {
        errorCode = 'ERROR_DUPLICATE_TWEET';
      } else if (txError.message.includes('ERROR_BALANCE')) {
        errorCode = 'ERROR_BALANCE';
      } else if (txError.message.includes('ERROR_ALLOWANCE')) {
        errorCode = 'ERROR_ALLOWANCE';
      }
      
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: receiverProfile.id,
        amount: amount, 
        fee: fee, 
        tx_hash: errorCode,
        type: 'p2p_command', 
        tweet_id: tweet.id, 
        payer_pay_tag: senderProfile.pay_tag,
        recipient_pay_tag: receiverProfile.pay_tag
      });
    }
  } catch (error) {
    console.error('❌ Error in processP2PCommand:', error.message);
  }
}
