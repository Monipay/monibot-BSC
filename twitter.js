import { TwitterApi } from 'twitter-api-v2';
import { evaluateCampaignReply } from './gemini.js';
import { 
  getProfileByXUsername, 
  getProfileByMonitag, 
  checkIfAlreadyGranted,
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

// Extract tags (mentions) from text
function extractPayTags(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot'); 
}

// Poll for campaign replies
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
      console.log('No recent tweets found');
      return;
    }
    
    for (const tweet of myTweets.data.data) {
      await processCampaignTweet(tweet);
    }
    
  } catch (error) {
    console.error('Error polling campaigns:', error);
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
    
    console.log(`Found ${replies.data.data.length} replies to tweet ${campaignTweet.id}`);
    
    for (const reply of replies.data.data) {
      const author = replies.includes?.users?.find(u => u.id === reply.author_id);
      if (!author) {
        console.log(`  ⚠️ Could not find author for reply ${reply.id}`);
        continue;
      }
      
      await processReply(reply, author, campaignTweet);
    }
    
  } catch (error) {
    console.error(`Error processing campaign tweet ${campaignTweet.id}:`, error);
  }
}

async function processReply(reply, author, campaignTweet) {
  try {
    console.log(`\n📝 Processing reply from @${author.username}`);
    
    const payTags = extractPayTags(reply.text);
    if (payTags.length === 0) {
      console.log('  ⏭️  No pay tags found, skipping');
      return;
    }
    
    console.log(`  Found tags: ${payTags.join(', ')}`);
    
    const authorProfile = await getProfileByXUsername(author.username);
    if (!authorProfile || !authorProfile.x_verified) {
      console.log(`  ⏭️  @${author.username} not verified, skipping`);
      return;
    }
    
    for (const tag of payTags) {
      await processPayTag(tag, reply, author, campaignTweet, authorProfile);
    }
    
  } catch (error) {
    console.error('Error processing reply:', error);
  }
}

async function processPayTag(payTag, reply, author, campaignTweet, authorProfile) {
  try {
    console.log(`  💎 Processing @${payTag}...`);
    
    const targetProfile = await getProfileByMonitag(payTag);
    if (!targetProfile) {
      console.log(`    ⏭️  @${payTag} not found in database`);
      return;
    }
    
    const alreadyGranted = await checkIfAlreadyGranted(campaignTweet.id, targetProfile.id);
    if (alreadyGranted) {
      console.log(`    ⏭️  Already granted to @${payTag} in this campaign`);
      return;
    }
    
    console.log(`    🤖 Evaluating with Gemini...`);
    const evaluation = await evaluateCampaignReply({
      campaignTweet: campaignTweet.text,
      reply: reply.text,
      replyAuthor: author.username,
      targetPayTag: payTag,
      isNewUser: new Date(targetProfile.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    });
    
    if (!evaluation.approved) {
      console.log(`    ❌ Rejected: ${evaluation.reasoning}`);
      return;
    }
    
    console.log(`    ✅ Approved: $${evaluation.amount} - ${evaluation.reasoning}`);
    
    const grantAmount = evaluation.amount;
    const fee = grantAmount * (parseFloat(process.env.GRANT_FEE_PERCENT) / 100);
    const netAmount = grantAmount - fee;
    
    console.log(`    💸 Transferring $${netAmount.toFixed(2)} (fee: $${fee.toFixed(2)})...`);
    const txHash = await transferUSDC(targetProfile.wallet_address, netAmount);
    console.log(`    ✅ Transfer complete: ${txHash}`);
    
    // NEW LOGGING FOR OPENCLAW
    await logTransaction({
      sender_id: process.env.MONIBOT_PROFILE_ID,
      receiver_id: targetProfile.id,
      amount: netAmount,
      fee: fee,
      tx_hash: txHash,
      campaign_id: campaignTweet.id,
      type: 'grant',
      tweet_id: reply.id,      // Saved for Social Agent
      payer_pay_tag: 'MoniBot' // Grant comes from the bot
    });
    
    await markAsGranted(campaignTweet.id, targetProfile.id);
    console.log(`    💾 Saved to DB. OpenClaw will handle the reply.`);
    
  } catch (error) {
    console.error(`Error processing tag @${payTag}:`, error);
  }
}

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
      console.log('No new command mentions found');
      return;
    }
    
    console.log(`Found ${mentions.data.data.length} command mentions`);
    lastProcessedTweetId = mentions.data.meta.newest_id;
    
    for (const tweet of mentions.data.data) {
      const author = mentions.includes?.users?.find(u => u.id === tweet.author_id);
      if (!author) continue;
      await processCommand(tweet, author);
    }
    
  } catch (error) {
    console.error('Error polling commands:', error);
  }
}

async function processCommand(tweet, author) {
  try {
    console.log(`\n⚡ Processing command from @${author.username}`);
    console.log(`   Text: ${tweet.text}`);
    
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
      console.log('  ⏭️  Could not parse command');
      return;
    }
    
    const senderProfile = await getProfileByXUsername(author.username);
    if (!senderProfile || !senderProfile.x_verified) {
      console.log(`  ❌ Sender @${author.username} not verified in DB`);
      return;
    }
    
    const allowance = await getOnchainAllowance(senderProfile.wallet_address);
    if (allowance < amount) {
      console.log(`  ❌ Insufficient allowance for @${author.username}: ${allowance}`);
      return;
    }
    
    let receiverProfile = await getProfileByMonitag(targetPayTag);
    if (!receiverProfile) receiverProfile = await getProfileByXUsername(targetPayTag);
    
    if (!receiverProfile) {
      console.log(`  ❌ Target @${targetPayTag} not found in DB`);
      return;
    }
    
    const fee = amount * (parseFloat(process.env.GRANT_FEE_PERCENT) / 100);
    const netAmount = amount - fee;
    
    console.log(`  💸 Executing transferFrom...`);
    const txHash = await transferFromUSDC(
      senderProfile.wallet_address,
      receiverProfile.wallet_address,
      netAmount,
      fee
    );
    console.log(`  ✅ Transfer complete: ${txHash}`);
    
    // NEW LOGGING FOR OPENCLAW
    await logTransaction({
      sender_id: senderProfile.id,
      receiver_id: receiverProfile.id,
      amount: netAmount,
      fee: fee,
      tx_hash: txHash,
      type: 'p2p_command',
      tweet_id: tweet.id,               // Saved for Social Agent
      payer_pay_tag: senderProfile.pay_tag // Save the sender's tag
    });
    
    console.log(`  💾 Saved P2P to DB. OpenClaw will handle the reply.`);
    
  } catch (error) {
    console.error('Error processing command:', error);
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
