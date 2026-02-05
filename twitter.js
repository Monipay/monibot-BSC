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
import { transferUSDC, transferFromUSDC, getOnchainAllowance } from './blockchain.js';

let twitterClient;
let lastProcessedTweetId = null;

export function initTwitterClient() {
  twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });
  
  console.log('✅ Twitter client initialized (Silent Worker Mode)');
}

/**
 * Extracts @mentions from tweet text, excluding the bot itself.
 */
function extractPayTags(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot'); 
}

/**
 * Loop 1: Campaign Replies
 * Fetches recent bot tweets and processes replies for grants.
 */
export async function pollCampaigns() {
  try {
    console.log('📊 Polling for campaign replies...');
    
    const myTweets = await twitterClient.v2.userTimeline(
      process.env.TWITTER_BOT_USER_ID || await getBotUserId(),
      {
        max_results: 10,
        'tweet.fields': ['created_at', 'conversation_id'],
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
    // 1. Double-Spend Protection: Has this reply already been handled?
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
      await processPayTag(tag, reply, author, campaignTweet, authorProfile);
    }
  } catch (error) {
    console.error('❌ Error in processReply:', error.message);
  }
}

async function processPayTag(payTag, reply, author, campaignTweet, authorProfile) {
  try {
    console.log(`   💎 Checking tag @${payTag}...`);
    
    const targetProfile = await getProfileByMonitag(payTag);
    if (!targetProfile) {
      console.log(`      ⏭️ Tag @${payTag} not found in database.`);
      // Optional: Log failure so agent can tell user to register
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: authorProfile.id, 
        amount: 0, fee: 0, tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot'
      });
      return;
    }

    const alreadyGranted = await checkIfAlreadyGranted(campaignTweet.id, targetProfile.id);
    if (alreadyGranted) {
      console.log(`      ⏭️ Grant already issued to ${payTag} for this campaign.`);
      return;
    }

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
        amount: 0, fee: 0, tx_hash: 'AI_REJECTED',
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot'
      });
      return;
    }

    const grantAmount = evaluation.amount;
    const fee = grantAmount * (parseFloat(process.env.GRANT_FEE_PERCENT || 1) / 100);
    const netAmount = grantAmount - fee;

    console.log(`      💸 Transferring $${netAmount.toFixed(2)} to ${payTag}...`);
    
    try {
      const txHash = await transferUSDC(targetProfile.wallet_address, netAmount);
      
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: netAmount,
        fee: fee,
        tx_hash: txHash,
        campaign_id: campaignTweet.id,
        type: 'grant',
        tweet_id: reply.id,
        payer_pay_tag: 'MoniBot'
      });
      
      await markAsGranted(campaignTweet.id, targetProfile.id);
      console.log(`      ✅ Grant Success! TX: ${txHash}`);
    } catch (txError) {
      console.error(`      ❌ Blockchain Revert:`, txError.message);
      await logTransaction({
        sender_id: process.env.MONIBOT_PROFILE_ID,
        receiver_id: targetProfile.id,
        amount: 0, fee: 0, tx_hash: 'ERROR_TREASURY_EMPTY',
        type: 'grant', tweet_id: reply.id, payer_pay_tag: 'MoniBot'
      });
    }
  } catch (error) {
    console.error(`❌ Error processing @${payTag}:`, error.message);
  }
}

/**
 * Loop 2: P2P Commands
 * Searches for @monibot mentions with "send" or "pay".
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
      if (author) await processCommand(tweet, author);
    }
  } catch (error) {
    console.error('❌ Error polling commands:', error.message);
  }
}

async function processCommand(tweet, author) {
  try {
    // 1. Double-Spend Protection: Was this command already processed?
    const alreadyHandled = await checkIfCommandProcessed(tweet.id);
    if (alreadyHandled) {
      console.log(`   ⏭️ Command ${tweet.id} already in DB, skipping.`);
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
      console.log('   ⏭️ Could not parse command syntax.');
      return;
    }
    
    console.log(`   💰 Amount: $${amount} | Target: @${targetPayTag}`);

    // Verify Sender
    const senderProfile = await getProfileByXUsername(author.username);
    if (!senderProfile) {
      console.log(`   ❌ Sender @${author.username} not found/verified.`);
      return;
    }
    
    const feePercent = parseFloat(process.env.GRANT_FEE_PERCENT || 1);
    const fee = amount * (feePercent / 100);
    const totalNeeded = amount + fee;

    // Verify On-chain Allowance
    const allowance = await getOnchainAllowance(senderProfile.wallet_address);
    if (allowance < totalNeeded) {
      console.log(`   ❌ Insufficient Allowance: Need $${totalNeeded}, have $${allowance}`);
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, fee: fee, tx_hash: 'ERROR_ALLOWANCE',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag
      });
      return;
    }
    
    // Verify Receiver
    let receiverProfile = await getProfileByMonitag(targetPayTag) || await getProfileByXUsername(targetPayTag);
    if (!receiverProfile) {
      console.log(`   ❌ Target @${targetPayTag} not found in MoniPay.`);
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: senderProfile.id,
        amount: amount, fee: fee, tx_hash: 'ERROR_TARGET_NOT_FOUND',
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag
      });
      return;
    }
    
    console.log(`   💸 Executing transfer: ${senderProfile.pay_tag} -> ${targetPayTag}`);
    
    try {
      const txHash = await transferFromUSDC(
        senderProfile.wallet_address,
        receiverProfile.wallet_address,
        amount,
        fee
      );

      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: receiverProfile.id,
        amount: amount,
        fee: fee,
        tx_hash: txHash,
        type: 'p2p_command',
        tweet_id: tweet.id,
        payer_pay_tag: senderProfile.pay_tag
      });
      
      console.log(`   ✅ P2P Success! TX: ${txHash}`);
    } catch (txError) {
      console.error(`   ❌ Blockchain Revert:`, txError.message);
      const errType = txError.message.includes('Balance') ? 'ERROR_BALANCE' : 'ERROR_BLOCKCHAIN';
      await logTransaction({
        sender_id: senderProfile.id,
        receiver_id: receiverProfile.id,
        amount: amount, fee: fee, tx_hash: errType,
        type: 'p2p_command', tweet_id: tweet.id, payer_pay_tag: senderProfile.pay_tag
      });
    }
  } catch (error) {
    console.error('❌ Error in processCommand:', error.message);
  }
}

async function getBotUserId() {
  try {
    const me = await twitterClient.v2.me();
    return me.data.id;
  } catch (error) {
    return process.env.TWITTER_BOT_USER_ID;
  }
}
