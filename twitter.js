import { TwitterApi } from 'twitter-api-v2';
import { evaluateCampaignReply, evaluateP2PCommand } from './gemini.js';
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
  
  console.log('✅ Twitter client initialized');
}

// Extract @monitag mentions from text
function extractMonitags(text) {
  const matches = text.match(/@([a-zA-Z0-9_-]+)/g) || [];
  return matches
    .map(m => m.slice(1).toLowerCase())
    .filter(m => m !== 'monibot'); // Exclude @monibot itself
}

// Poll for campaign replies
export async function pollCampaigns() {
  try {
    console.log('📊 Polling for campaign replies...');
    
    // Get MoniBot's recent tweets (last 24 hours)
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
    
    // Process each campaign tweet
    for (const tweet of myTweets.data.data) {
      await processCampaignTweet(tweet);
    }
    
  } catch (error) {
    console.error('Error polling campaigns:', error);
  }
}

async function processCampaignTweet(campaignTweet) {
  try {
    // Get replies to this tweet
    const replies = await twitterClient.v2.search({
      query: `conversation_id:${campaignTweet.id}`,
      max_results: 100,
      'tweet.fields': ['author_id', 'created_at'],
      'user.fields': ['username']
    });
    
    if (!replies.data?.data) return;
    
    console.log(`Found ${replies.data.data.length} replies to tweet ${campaignTweet.id}`);
    
    // Process each reply
    for (const reply of replies.data.data) {
      const author = replies.includes?.users?.find(u => u.id === reply.author_id);
      if (!author) continue;
      
      await processReply(reply, author, campaignTweet);
    }
    
  } catch (error) {
    console.error(`Error processing campaign tweet ${campaignTweet.id}:`, error);
  }
}

async function processReply(reply, author, campaignTweet) {
  try {
    console.log(`\n📝 Processing reply from @${author.username}`);
    
    // Extract monitags
    const monitags = extractMonitags(reply.text);
    if (monitags.length === 0) {
      console.log('  ⏭️  No monitags found, skipping');
      return;
    }
    
    console.log(`  Found monitags: ${monitags.join(', ')}`);
    
    // Verify reply author has verified X account
    const authorProfile = await getProfileByXUsername(author.username);
    if (!authorProfile || !authorProfile.x_verified) {
      console.log(`  ⏭️  @${author.username} not verified, skipping`);
      return;
    }
    
    // Process each monitag
    for (const monitag of monitags) {
      await processMonitag(monitag, reply, author, campaignTweet, authorProfile);
    }
    
  } catch (error) {
    console.error('Error processing reply:', error);
  }
}

async function processMonitag(monitag, reply, author, campaignTweet, authorProfile) {
  try {
    console.log(`  💎 Processing @${monitag}...`);
    
    // Check if monitag exists
    const targetProfile = await getProfileByMonitag(monitag);
    if (!targetProfile) {
      console.log(`    ⏭️  @${monitag} not found in database`);
      return;
    }
    
    // Check if already granted
    const alreadyGranted = await checkIfAlreadyGranted(campaignTweet.id, targetProfile.id);
    if (alreadyGranted) {
      console.log(`    ⏭️  Already granted to @${monitag} in this campaign`);
      return;
    }
    
    // Evaluate with Gemini
    console.log(`    🤖 Evaluating with Gemini...`);
    const evaluation = await evaluateCampaignReply({
      campaignTweet: campaignTweet.text,
      reply: reply.text,
      replyAuthor: author.username,
      targetMonitag: monitag,
      isNewUser: new Date(targetProfile.created_at) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    });
    
    if (!evaluation.approved) {
      console.log(`    ❌ Rejected: ${evaluation.reasoning}`);
      return;
    }
    
    console.log(`    ✅ Approved: $${evaluation.amount} - ${evaluation.reasoning}`);
    
    // Execute transfer
    const grantAmount = evaluation.amount;
    const fee = grantAmount * (parseFloat(process.env.GRANT_FEE_PERCENT) / 100);
    const netAmount = grantAmount - fee;
    
    console.log(`    💸 Transferring $${netAmount.toFixed(2)} (fee: $${fee.toFixed(2)})...`);
    
    const txHash = await transferUSDC(targetProfile.wallet_address, netAmount);
    
    console.log(`    ✅ Transfer complete: ${txHash}`);
    
    // Log transaction
    await logTransaction({
      sender_id: process.env.MONIBOT_PROFILE_ID,
      receiver_id: targetProfile.id,
      amount: netAmount,
      fee: fee,
      tx_hash: txHash,
      campaign_id: campaignTweet.id,
      type: 'grant'
    });
    
    // Reply to tweet
    const replyText = `✅ Sent $${netAmount.toFixed(2)} USDC to @${monitag}! TX: ${txHash.slice(0, 10)}...${txHash.slice(-8)}`;
    await twitterClient.v2.reply(replyText, reply.id);
    
    console.log(`    💬 Replied to tweet`);
    
    // Mark as granted
    await markAsGranted(campaignTweet.id, targetProfile.id);
    
  } catch (error) {
    console.error(`Error processing monitag @${monitag}:`, error);
  }
}

// Poll for P2P payment commands
export async function pollCommands() {
  try {
    console.log('💬 Polling for P2P commands...');
    
    // Search for mentions of @monibot with "send" or "pay"
    const mentions = await twitterClient.v2.search({
      query: '@monibot (send OR pay) -is:retweet',
      max_results: 50,
      'tweet.fields': ['author_id', 'created_at'],
      'user.fields': ['username'],
      since_id: lastProcessedTweetId
    });
    
    if (!mentions.data?.data) {
      console.log('No new command mentions found');
      return;
    }
    
    console.log(`Found ${mentions.data.data.length} command mentions`);
    
    // Update last processed
    if (mentions.data.data.length > 0) {
      lastProcessedTweetId = mentions.data.meta.newest_id;
    }
    
    // Process each command
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
    
    // Parse command (send $X to @monitag)
    const sendMatch = tweet.text.match(/send\s+\$?(\d+\.?\d*)\s+to\s+@?([a-zA-Z0-9_-]+)/i);
    const payMatch = tweet.text.match(/pay\s+@?([a-zA-Z0-9_-]+)\s+\$?(\d+\.?\d*)/i);
    
    let amount, targetMonitag;
    
    if (sendMatch) {
      amount = parseFloat(sendMatch[1]);
      targetMonitag = sendMatch[2].toLowerCase();
    } else if (payMatch) {
      amount = parseFloat(payMatch[2]);
      targetMonitag = payMatch[1].toLowerCase();
    } else {
      console.log('  ⏭️  Could not parse command');
      return;
    }
    
    console.log(`  💰 Amount: $${amount}`);
    console.log(`  🎯 Target: @${targetMonitag}`);
    
    // Verify sender
    const senderProfile = await getProfileByXUsername(author.username);
    if (!senderProfile || !senderProfile.x_verified) {
      await twitterClient.v2.reply(
        `❌ You need to verify your X account in MoniPay first! Visit monipay.xyz/settings`,
        tweet.id
      );
      return;
    }
    
    // Check allowance
    const allowance = await getOnchainAllowance(senderProfile.wallet_address);
    if (allowance < amount) {
      await twitterClient.v2.reply(
        `❌ Insufficient allowance! You have $${allowance.toFixed(2)} approved. Increase it at monipay.xyz/settings`,
        tweet.id
      );
      return;
    }
    
    // Verify receiver
    let receiverProfile = await getProfileByMonitag(targetMonitag);
    if (!receiverProfile) {
      // Try as X username
      receiverProfile = await getProfileByXUsername(targetMonitag);
    }
    
    if (!receiverProfile) {
      await twitterClient.v2.reply(
        `❌ @${targetMonitag} not found on MoniPay!`,
        tweet.id
      );
      return;
    }
    
    // Execute transferFrom
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
    
    // Log transaction
    await logTransaction({
      sender_id: senderProfile.id,
      receiver_id: receiverProfile.id,
      amount: netAmount,
      fee: fee,
      tx_hash: txHash,
      type: 'p2p_command'
    });
    
    // Reply
    await twitterClient.v2.reply(
      `✅ @${author.username} sent $${netAmount.toFixed(2)} to @${targetMonitag}! TX: ${txHash.slice(0, 10)}...${txHash.slice(-8)}`,
      tweet.id
    );
    
    console.log(`  💬 Replied to tweet`);
    
  } catch (error) {
    console.error('Error processing command:', error);
    try {
      await twitterClient.v2.reply(
        `❌ Transaction failed. Please try again or contact support.`,
        tweet.id
      );
    } catch (replyError) {
      console.error('Failed to send error reply:', replyError);
    }
  }
}

async function getBotUserId() {
  const me = await twitterClient.v2.me();
  return me.data.id;
}