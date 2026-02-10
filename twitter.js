/**
 * MoniBot Worker - Twitter Module (Silent Worker Mode - BSC/USDT)
 * 
 * This module polls Twitter for:
 * 1. Campaign Replies - Process grants via MoniBotRouter on BSC
 * 2. P2P Commands - Process "send $X to @user" via MoniBotRouter on BSC
 * 
 * Architecture:
 * - Network: BSC Mainnet
 * - Token: USDT (18 Decimals)
 * - Router: MoniBotRouter
 * 
 * IMPORTANT: This is a "Silent Worker" - it does NOT reply via Twitter API.
 * All results are logged to monibot_transactions for the Social Agent.
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
  getUSDTBalance, // Renamed from getUSDCBalance
  isTweetProcessed,
  isGrantAlreadyIssued,
  calculateFee,
  MONIBOT_ROUTER_ADDRESS
} from './blockchain.js';

let twitterClient;
let lastProcessedTweetId = null;

// MoniBot's wallet address for ledger syncing
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

async function getBotUserId() {
  try {
    const me = await twitterClient.v2.me();
    return me.data.id;
  } catch (error) {
    return process.env.TWITTER_BOT_USER_ID;
  }
}

// ============ Loop 1: Campaign Replies (DB-Driven) ============

export async function pollCampaigns() {
  try {
    console.log('📊 Polling for campaign replies...');
    
    const activeCampaigns = await getActiveCampaigns();
    
    if (!activeCampaigns || activeCampaigns.length === 0) {
      console.log('   No active campaigns found.');
      return;
    }
    
    console.log(`   Found ${activeCampaigns.length} active campaign(s)`);
    
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
  }
}

async function processCampaignReplies(campaign) {
  try {
    console.log(`\n🔍 Checking campaign: ${campaign.tweet_id}`);
    console.log(`   Grant: $${campaign.grant_amount} | ${campaign.current_participants || 0}/${campaign.max_participants || '∞'} participants`);
    
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

    console.log(`\n📝 Processing reply from @${author.username}: "${reply.text.substring(0, 50)}..."`);
    
    const targetPayTag = extractFirstPayTag(reply.text);
    if (!targetPayTag) {
      console.log('   ⏭️ No valid pay tags found, logging skip.');
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0, fee: 0, tx_hash: 'SKIP_NO_PAYTAG',
        campaign_id: campaign.tweet_id,
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: null
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
    console.log(`   💎 Processing grant for @${payTag}...`);
    
    const targetProfile = await getProfileByMonitag(payTag);
    if (!targetProfile) {
      console.log(`      ⏭️ Tag @${payTag} not found in database.`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0, fee: 0, tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: payTag
      });
      return;
    }

    const currentCampaign = await getCampaignByTweetId(campaign.tweet_id);
    if (!currentCampaign) {
      console.log(`      ⏭️ Campaign not found or no longer active`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0, fee: 0, tx_hash: 'SKIP_CAMPAIGN_INACTIVE',
        campaign_id: campaign.tweet_id,
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: targetProfile.pay_tag
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
        amount: 0, fee: 0, tx_hash: 'LIMIT_REACHED',
        campaign_id: campaign.tweet_id,
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: targetProfile.pay_tag
      });
      return;
    }

    const alreadyGrantedDB = await checkIfAlreadyGranted(campaign.tweet_id, targetProfile.id);
    if (alreadyGrantedDB) {
      console.log(`      ⏭️ Grant already issued to ${payTag} for this campaign (DB).`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0, fee: 0, tx_hash: 'SKIP_DUPLICATE_GRANT_DB',
        campaign_id: campaign.tweet_id,
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: targetProfile.pay_tag
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
        amount: 0, fee: 0, tx_hash: 'SKIP_DUPLICATE_GRANT_ONCHAIN',
        campaign_id: campaign.tweet_id,
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: targetProfile.pay_tag
      });
      return;
    }

    const { fee, netAmount } = await calculateFee(grantAmount);
    console.log(`      💰 Grant: $${grantAmount} USDT (Net: $${netAmount}, Fee: $${fee})`);

    console.log(`      💸 Executing grant via BSC Router...`);
    
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
        campaignName: campaign.message?.substring(0, 50) || 'MoniBot Campaign'
      });
      
      console.log(`      ✅ Grant Success! TX: ${hash}`);
      
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
        amount: 0, fee: 0, tx_hash: errorCode,
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot', recipient_pay_tag: targetProfile.pay_tag
      });
    }
  } catch (error) {
    console.error(`❌ Error processing grant for @${payTag}:`, error.message);
  }
}

// ============ Loop 2: P2P Commands ============

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
    const alreadyHandled = await checkIfCommandProcessed(tweet.id);
    if (alreadyHandled) return;

    const tweetAlreadyOnChain = await isTweetProcessed(tweet.id);
    if (tweetAlreadyOnChain) {
      console.log(`   ⏭️ Tweet ${tweet.id} already processed on-chain, logging to DB...`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0, fee: 0, tx_hash: 'SKIP_ALREADY_ONCHAIN',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: author.username, recipient_pay_tag: null
      });
      return;
    }

    console.log(`\n⚡ Processing P2P command from @${author.username}`);
    
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
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: process.env.MONIBOT_PROFILE_ID,
        amount: 0, fee: 0, tx_hash: 'SKIP_INVALID_SYNTAX',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: author.username, recipient_pay_tag: null
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
        amount: amount, fee: 0, tx_hash: 'ERROR_SENDER_NOT_FOUND',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: author.username, recipient_pay_tag: targetPayTag
      });
      return;
    }
    
    const { fee, netAmount } = await calculateFee(amount);
    console.log(`   📊 Gross: $${amount} | Net: $${netAmount} | Fee: $${fee}`);

    const allowance = await getOnchainAllowance(senderProfile.wallet_address);
    if (allowance < amount) {
      console.log(`   ❌ Insufficient Allowance: Need $${amount}, approved $${allowance}`);
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, fee: fee, tx_hash: 'ERROR_ALLOWANCE',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag, recipient_pay_tag: targetPayTag
      });
      return;
    }

    const balance = await getUSDTBalance(senderProfile.wallet_address); // CHANGED: USDT
    if (balance < amount) {
      console.log(`   ❌ Insufficient Balance: Need $${amount}, have $${balance}`);
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, fee: fee, tx_hash: 'ERROR_BALANCE',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag, recipient_pay_tag: targetPayTag
      });
      return;
    }
    
    let receiverProfile = await getProfileByMonitag(targetPayTag) || await getProfileByXUsername(targetPayTag);
    if (!receiverProfile) {
      console.log(`   ❌ Target @${targetPayTag} not found in MoniPay.`);
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, fee: fee, tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag, recipient_pay_tag: targetPayTag
      });
      return;
    }
    
    console.log(`   💸 Executing P2P via BSC Router: ${senderProfile.pay_tag} -> ${targetPayTag}`);
    
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
      
      console.log(`   ✅ P2P Success! TX: ${hash}`);
      
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
        amount: amount, fee: fee, tx_hash: errorCode,
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag, recipient_pay_tag: receiverProfile.pay_tag
      });
    }
  } catch (error) {
    console.error('❌ Error in processP2PCommand:', error.message);
  }
}
