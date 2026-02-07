/**
 * MoniBot Worker - Twitter Module (Silent Worker Mode)
 * 
 * This module polls Twitter for:
 * 1. Campaign Replies - Process grants for qualifying replies
 * 2. P2P Commands - Process "send $X to @user" commands
 * 
 * IMPORTANT: This is a "Silent Worker" - it does NOT reply via Twitter API.
 * All results (success/failure) are logged to monibot_transactions table.
 * A separate Social Agent reads this table and handles replies.
 */

import { TwitterApi } from 'twitter-api-v2';
import { evaluateCampaignReply } from './gemini.js';
import { 
  getProfileByXUsername, 
  getProfileByMonitag, 
  checkIfAlreadyGranted,
  checkIfCommandProcessed,
  markAsGranted,
  logTransaction 
} from './database.js';
import { 
  executeP2PViaRouter, 
  executeGrantViaRouter, 
  getOnchainAllowance,
  getUSDCBalance,
  isTweetProcessed,
  isGrantAlreadyIssued,
  calculateFee
} from './blockchain.js';

let twitterClient;
let lastProcessedTweetId = null;

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
 */
function extractPayTags(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot'); 
}

async function getBotUserId() {
  try {
    const me = await twitterClient.v2.me();
    return me.data.id;
  } catch (error) {
    return process.env.TWITTER_BOT_USER_ID;
  }
}

// ============ Loop 1: Campaign Replies ============

/**
 * Fetches recent bot tweets and processes replies for grants.
 * Grants are funded from the MoniBotRouter contract balance.
 */
export async function pollCampaigns() {
  try {
    console.log('📊 Polling for campaign replies...');
    
    const myTweets = await twitterClient.v2.userTimeline(
      process.env.TWITTER_BOT_USER_ID || await getBotUserId(),
      {
        max_results: 10,
        'tweet.fields': ['created_at', 'conversation_id', 'text'],
        start_time: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      }
    );
    
    if (!myTweets.data?.data) {
      console.log('   No recent tweets found.');
      return;
    }
    
    for (const tweet of myTweets.data.data) {
      await processCampaignTweet(tweet);
    }
  } catch (error) {
    console.error('❌ Error polling campaigns:', error.message);
  }
}

async function processCampaignTweet(campaignTweet) {
  try {
    const replies = await twitterClient.v2.search({
      query: `conversation_id:${campaignTweet.id}`,
      max_results: 100,
      'tweet.fields': ['author_id', 'created_at'],
      'user.fields': ['username'],
      expansions: ['author_id']
    });
    
    if (!replies.data?.data) return;
    
    console.log(`🔎 Found ${replies.data.data.length} replies to campaign ${campaignTweet.id}`);
    
    for (const reply of replies.data.data) {
      const author = replies.includes?.users?.find(u => u.id === reply.author_id);
      if (!author) continue;
      
      await processReply(reply, author, campaignTweet);
    }
  } catch (error) {
    console.error(`❌ Error processing replies for ${campaignTweet.id}:`, error.message);
  }
}

async function processReply(reply, author, campaignTweet) {
  try {
    // 1. Double-Spend Protection: Has this reply already been handled in DB?
    const alreadyHandled = await checkIfCommandProcessed(reply.id);
    if (alreadyHandled) return;

    console.log(`\n📝 Processing reply from @${author.username}`);
    
    const payTags = extractPayTags(reply.text);
    if (payTags.length === 0) {
      console.log('   ⏭️ No pay tags found, skipping.');
      return;
    }
    
    const authorProfile = await getProfileByXUsername(author.username);
    if (!authorProfile || !authorProfile.x_verified) {
      console.log(`   ⏭️ @${author.username} not verified in MoniPay, skipping.`);
      return;
    }
    
    for (const tag of payTags) {
      await processGrantForPayTag(tag, reply, author, campaignTweet, authorProfile);
    }
  } catch (error) {
    console.error('❌ Error in processReply:', error.message);
  }
}

async function processGrantForPayTag(payTag, reply, author, campaignTweet, authorProfile) {
  try {
    console.log(`   💎 Checking tag @${payTag}...`);
    
    // 1. Resolve target profile
    const targetProfile = await getProfileByMonitag(payTag);
    if (!targetProfile) {
      console.log(`      ⏭️ Tag @${payTag} not found in database.`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: authorProfile.id, 
        amount: 0, 
        fee: 0, 
        tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'grant', 
        tweet_id: reply.id, 
        payer_pay_tag: 'MoniBot'
      });
      return;
    }

    // 2. Check if already granted (DB check for fast path)
    const alreadyGrantedDB = await checkIfAlreadyGranted(campaignTweet.id, targetProfile.id);
    if (alreadyGrantedDB) {
      console.log(`      ⏭️ Grant already issued to ${payTag} for this campaign (DB).`);
      return;
    }

    // 3. Check if already granted on-chain (contract check for safety)
    const alreadyGrantedOnChain = await isGrantAlreadyIssued(campaignTweet.id, targetProfile.wallet_address);
    if (alreadyGrantedOnChain) {
      console.log(`      ⏭️ Grant already issued on-chain, syncing DB...`);
      await markAsGranted(campaignTweet.id, targetProfile.id);
      return;
    }

    // 4. AI Evaluation
    console.log(`      🤖 Evaluating with Gemini...`);
    const evaluation = await evaluateCampaignReply({
      campaignTweet: campaignTweet.text,
      reply: reply.text,
      replyAuthor: author.username,
      targetPayTag: payTag,
      isNewUser: new Date(targetProfile.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    });

    if (!evaluation.approved) {
      console.log(`      ❌ Rejected: ${evaluation.reasoning}`);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0, 
        fee: 0, 
        tx_hash: 'AI_REJECTED',
        type: 'grant', 
        tweet_id: reply.id, 
        payer_pay_tag: 'MoniBot'
      });
      return;
    }

    const grantAmount = evaluation.amount;
    
    // 5. Calculate fee (contract will enforce this)
    const { fee, netAmount } = await calculateFee(grantAmount);
    console.log(`      💰 Grant: $${grantAmount} (Net: $${netAmount}, Fee: $${fee})`);

    // 6. Execute grant via Router contract
    console.log(`      💸 Executing grant via Router...`);
    
    try {
      const { hash, fee: actualFee } = await executeGrantViaRouter(
        targetProfile.wallet_address,
        grantAmount,
        campaignTweet.id // campaignId for on-chain deduplication
      );
      
      // Log success to DB
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: grantAmount - actualFee, // Net amount received
        fee: actualFee,
        tx_hash: hash,
        campaign_id: campaignTweet.id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot'
      });
      
      await markAsGranted(campaignTweet.id, targetProfile.id);
      console.log(`      ✅ Grant Success! TX: ${hash}`);
      
    } catch (txError) {
      console.error(`      ❌ Router Error:`, txError.message);
      
      // Parse error type for Social Agent
      let errorCode = 'ERROR_BLOCKCHAIN';
      if (txError.message.includes('ERROR_DUPLICATE_GRANT')) {
        errorCode = 'ERROR_DUPLICATE_GRANT';
      } else if (txError.message.includes('ERROR_CONTRACT_BALANCE')) {
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
        payer_pay_tag: 'MoniBot'
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
      console.log(`   ⏭️ Command ${tweet.id} already in DB, skipping.`);
      return;
    }

    // 2. On-chain deduplication check
    const tweetAlreadyOnChain = await isTweetProcessed(tweet.id);
    if (tweetAlreadyOnChain) {
      console.log(`   ⏭️ Tweet ${tweet.id} already processed on-chain, skipping.`);
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
      console.log('   ⏭️ Could not parse command syntax.');
      return;
    }
    
    console.log(`   💰 Amount: $${amount} | Target: @${targetPayTag}`);

    // 4. Verify Sender exists and is verified
    const senderProfile = await getProfileByXUsername(author.username);
    if (!senderProfile) {
      console.log(`   ❌ Sender @${author.username} not found/verified.`);
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
        payer_pay_tag: senderProfile.pay_tag
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
        payer_pay_tag: senderProfile.pay_tag
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
        payer_pay_tag: senderProfile.pay_tag
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

      // Log success to DB
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: receiverProfile.id,
        amount: amount - actualFee, // Net amount received
        fee: actualFee,
        tx_hash: hash,
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: senderProfile.pay_tag
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
        payer_pay_tag: senderProfile.pay_tag
      });
    }
  } catch (error) {
    console.error('❌ Error in processP2PCommand:', error.message);
  }
}
