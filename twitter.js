/**
 * MoniBot Worker - Twitter Module (Silent Worker Mode)
 * 
 * This module polls Twitter for:
 * 1. Campaign Replies - Process grants for qualifying replies (FIRST COME FIRST SERVE)
 * 2. P2P Commands - Process "send $X to @user" commands
 * 
 * IMPORTANT: This is a "Silent Worker" - it does NOT reply via Twitter API.
 * All results (success/failure) are logged to monibot_transactions table.
 * A separate Social Agent reads this table and handles replies.
 * 
 * GRANT LOGIC (v3.0 - Database-Driven):
 * - Fetches active campaigns from DB
 * - Searches for replies using conversation_id
 * - No AI spam checking - every valid @paytag gets a grant
 * - First come, first serve until max_participants reached
 * - Grant amount comes from the campaign record
 * - One grant per reply (first mentioned paytag only)
 * - Syncs successful transactions to main ledger
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
  getUSDCBalance,
  isTweetProcessed,
  isGrantAlreadyIssued,
  calculateFee,
  MONIBOT_ROUTER_ADDRESS
} from './blockchain.js';

let twitterClient;
let lastProcessedTweetId = null;

// MoniBot's wallet address for ledger syncing
const MONIBOT_WALLET_ADDRESS = process.env.MONIBOT_WALLET_ADDRESS || '0x...'; // Set in env

// ============ Initialization ============

export function initTwitterClient() {
  twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
  
  console.log('✅ Twitter client initialized (Silent Worker Mode - Router Architecture)');
}

// ============ Utility Functions ============

/**
 * Extracts @mentions from tweet text, excluding the bot itself.
 * Returns ONLY the first valid paytag (one grant per reply).
 */
function extractFirstPayTag(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  const filtered = matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay');
  
  return filtered.length > 0 ? filtered[0] : null;
}

/**
 * Extracts all @mentions from tweet text, excluding the bot.
 * Used for P2P commands where we need the target.
 */
function extractPayTags(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot' && m !== 'monipay'); 
}

async function getBotUserId() {
  try {
    const me = await twitterClient.v2.me();
    return me.data.id;
  } catch (error) {
    return process.env.TWITTER_BOT_USER_ID;
  }
}

// ============ Loop 1: Campaign Replies (DB-Driven) ============

/**
 * Fetches active campaigns from DB and searches for replies.
 * This is more reliable than polling bot's timeline.
 * Grants are funded from the MoniBotRouter contract balance.
 */
export async function pollCampaigns() {
  try {
    console.log('📊 Polling for campaign replies...');
    
    // 1. Get active campaigns from database
    const activeCampaigns = await getActiveCampaigns();
    
    if (!activeCampaigns || activeCampaigns.length === 0) {
      console.log('   No active campaigns found.');
      return;
    }
    
    console.log(`   Found ${activeCampaigns.length} active campaign(s)`);
    
    // 2. Process each campaign
    for (const campaign of activeCampaigns) {
      // Skip if campaign is already at max participants
      if (campaign.current_participants >= (campaign.max_participants || 999999)) {
        console.log(`   ⏭️ Campaign ${campaign.id.substring(0, 8)} already at max participants`);
        continue;
      }
      
      // Skip if no tweet_id (campaign not yet posted)
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

/**
 * Search for replies to a specific campaign tweet and process them
 */
async function processCampaignReplies(campaign) {
  try {
    console.log(`\n🔍 Checking campaign: ${campaign.tweet_id}`);
    console.log(`   Grant: $${campaign.grant_amount} | ${campaign.current_participants || 0}/${campaign.max_participants || '∞'} participants`);
    
    // Search for replies using conversation_id
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
    
    // Process each reply
    for (const reply of replies.data.data) {
      const author = replies.includes?.users?.find(u => u.id === reply.author_id);
      if (!author) continue;
      
      await processReply(reply, author, campaign);
    }
  } catch (error) {
    console.error(`❌ Error processing campaign ${campaign.tweet_id}:`, error.message);
  }
}

/**
 * Process a single reply to a campaign tweet
 */
async function processReply(reply, author, campaign) {
  try {
    // 1. Double-Spend Protection: Has this reply already been handled in DB?
    const alreadyHandled = await checkIfCommandProcessed(reply.id);
    if (alreadyHandled) {
      // Already processed - silent skip (no log needed, already in DB)
      return;
    }

    console.log(`\n📝 Processing reply from @${author.username}: "${reply.text.substring(0, 50)}..."`);
    
    // 2. Extract FIRST valid paytag only (one grant per reply)
    const targetPayTag = extractFirstPayTag(reply.text);
    if (!targetPayTag) {
      console.log('   ⏭️ No valid pay tags found, logging skip.');
      // LOG THIS TO PREVENT INFINITE LOOP - mark tweet as processed even if no paytag
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
    
    // 3. Process the grant for this paytag
    await processGrantForPayTag(targetPayTag, reply, author, campaign);
  } catch (error) {
    console.error('❌ Error in processReply:', error.message);
  }
}

/**
 * Process a grant for a specific paytag from a campaign reply
 */
async function processGrantForPayTag(payTag, reply, author, campaign) {
  try {
    console.log(`   💎 Processing grant for @${payTag}...`);
    
    // 1. Resolve target profile (the @paytag mentioned)
    const targetProfile = await getProfileByMonitag(payTag);
    if (!targetProfile) {
      console.log(`      ⏭️ Tag @${payTag} not found in database.`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID, // Fallback to self since no target
        amount: 0, 
        fee: 0, 
        tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'grant', 
        tweet_id: reply.id, 
        payer_pay_tag: 'MoniBot',
        recipient_pay_tag: payTag // Log the attempted target
      });
      return;
    }

    // 2. Get current campaign stats (re-fetch for latest count)
    const currentCampaign = await getCampaignByTweetId(campaign.tweet_id);
    if (!currentCampaign) {
      console.log(`      ⏭️ Campaign not found or no longer active`);
      // LOG to prevent infinite loop
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

    // 3. Check if limit already reached (FIRST COME FIRST SERVE)
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

    // 4. Check if already granted (DB check for fast path)
    const alreadyGrantedDB = await checkIfAlreadyGranted(campaign.tweet_id, targetProfile.id);
    if (alreadyGrantedDB) {
      console.log(`      ⏭️ Grant already issued to ${payTag} for this campaign (DB).`);
      // LOG to prevent infinite loop - mark this tweet as processed
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

    // 5. Check if already granted on-chain (contract check for safety)
    const alreadyGrantedOnChain = await isGrantAlreadyIssued(campaign.tweet_id, targetProfile.wallet_address);
    if (alreadyGrantedOnChain) {
      console.log(`      ⏭️ Grant already issued on-chain, syncing DB...`);
      await markAsGranted(campaign.tweet_id, targetProfile.id);
      // LOG to prevent infinite loop
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

    // 6. Calculate fee (contract will enforce this)
    const { fee, netAmount } = await calculateFee(grantAmount);
    console.log(`      💰 Grant: $${grantAmount} (Net: $${netAmount}, Fee: $${fee})`);

    // 7. Execute grant via Router contract
    console.log(`      💸 Executing grant via Router...`);
    
    try {
      const { hash, fee: actualFee } = await executeGrantViaRouter(
        targetProfile.wallet_address,
        grantAmount,
        campaign.tweet_id // campaignId for on-chain deduplication
      );
      
      const netAmountReceived = grantAmount - actualFee;
      
      // 8. Log success to monibot_transactions
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
      
      // 9. Mark as granted in campaign_grants
      await markAsGranted(campaign.tweet_id, targetProfile.id);
      
      // 10. Increment campaign participants
      await incrementCampaignParticipants(campaign.tweet_id, grantAmount);
      
      // 11. Sync to main transactions ledger (for user receipts)
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
        campaignName: campaign.message?.substring(0, 50) || 'MoniBot Campaign'
      });
      
      console.log(`      ✅ Grant Success! TX: ${hash}`);
      
    } catch (txError) {
      console.error(`      ❌ Router Error:`, txError.message);
      
      // Parse error type for Social Agent
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

// ============ Loop 2: P2P Commands ============

/**
 * Searches for @monibot mentions with "send" or "pay".
 * P2P transfers use the sender's pre-approved allowance to MoniBotRouter.
 */
export async function pollCommands() {
  try {
    console.log('💬 Polling for P2P commands...');
    
    const searchParams = {
      query: '@monibot (send OR pay) -is:retweet',
      max_results: 50,
      'tweet.fields': ['author_id', 'created_at'],
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
    // 1. Double-Spend Protection: Was this command already processed in DB?
    const alreadyHandled = await checkIfCommandProcessed(tweet.id);
    if (alreadyHandled) {
      // Already in DB - silent skip
      return;
    }

    // 2. On-chain deduplication check
    const tweetAlreadyOnChain = await isTweetProcessed(tweet.id);
    if (tweetAlreadyOnChain) {
      console.log(`   ⏭️ Tweet ${tweet.id} already processed on-chain, logging to DB...`);
      // Log to DB so we don't keep checking on-chain
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

    console.log(`\n⚡ Processing P2P command from @${author.username}`);
    
    // 3. Parse command syntax
    const sendMatch = tweet.text.match(/send\s+\$?(\d+\.?\d*)\s+to\s+@?([a-zA-Z0-9_-]+)/i);
    const payMatch = tweet.text.match(/pay\s+@?([a-zA-Z0-9_-]+)\s+\$?(\d+\.?\d*)/i);
    
    let amount, targetPayTag;
    
    if (sendMatch) {
      amount = parseFloat(sendMatch[1]);
      targetPayTag = sendMatch[2].toLowerCase();
    } else if (payMatch) {
      amount = parseFloat(payMatch[2]);
      targetPayTag = payMatch[1].toLowerCase();
    } else {
      console.log('   ⏭️ Could not parse command syntax, logging skip.');
      // Log to prevent infinite loop
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
    
    console.log(`   💰 Amount: $${amount} | Target: @${targetPayTag}`);

    // 4. Verify Sender exists and is verified
    const senderProfile = await getProfileByXUsername(author.username);
    if (!senderProfile) {
      console.log(`   ❌ Sender @${author.username} not found/verified, logging skip.`);
      // Log to prevent infinite loop
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
    
    // 5. Pre-calculate fee for logging (contract enforces this)
    const { fee, netAmount } = await calculateFee(amount);
    console.log(`   📊 Gross: $${amount} | Net: $${netAmount} | Fee: $${fee}`);

    // 6. Check sender's allowance to Router (not bot wallet!)
    const allowance = await getOnchainAllowance(senderProfile.wallet_address);
    if (allowance < amount) {
      console.log(`   ❌ Insufficient Allowance: Need $${amount}, approved $${allowance}`);
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

    // 7. Check sender's balance
    const balance = await getUSDCBalance(senderProfile.wallet_address);
    if (balance < amount) {
      console.log(`   ❌ Insufficient Balance: Need $${amount}, have $${balance}`);
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
    
    // 8. Verify Receiver exists
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
    
    // 9. Execute P2P via Router contract
    console.log(`   💸 Executing P2P: ${senderProfile.pay_tag} -> ${targetPayTag}`);
    
    try {
      const { hash, fee: actualFee } = await executeP2PViaRouter(
        senderProfile.wallet_address,
        receiverProfile.wallet_address,
        amount,
        tweet.id // tweetId for on-chain deduplication
      );

      const netAmountReceived = amount - actualFee;

      // 10. Log success to monibot_transactions
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
      
      // 11. Sync to main transactions ledger (for user receipts)
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
      
      console.log(`   ✅ P2P Success! TX: ${hash}`);
      
    } catch (txError) {
      console.error(`   ❌ Router Error:`, txError.message);
      
      // Parse error type for Social Agent
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
