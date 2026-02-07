/**
 * MoniBot Worker - Database Module (Supabase)
 * 
 * This module handles all database operations for the Silent Worker.
 * All transactions are logged to monibot_transactions for the Social Agent to process.
 * 
 * Uses SERVICE_KEY (not anon key) to bypass RLS policies.
 */

import { createClient } from '@supabase/supabase-js';

let supabase;

// ============ Initialization ============

export function initSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  }
  
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  console.log('✅ Supabase initialized (Service Role)');
}

/**
 * Get the Supabase client instance
 * Used by other modules (scheduler, etc.)
 */
export function getSupabase() {
  if (!supabase) {
    throw new Error('Supabase not initialized. Call initSupabase() first.');
  }
  return supabase;
}

// ============ Profile Lookups ============

/**
 * Find a profile by their X/Twitter username
 * @param {string} xUsername - Twitter username (without @)
 * @returns {Promise<object|null>} Profile object or null
 */
export async function getProfileByXUsername(xUsername) {
  const cleanUsername = xUsername.replace('@', '').toLowerCase();
  
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('x_username', cleanUsername)
    .eq('x_verified', true)
    .maybeSingle();
  
  if (error) {
    console.error(`❌ Error fetching profile by X username ${xUsername}:`, error.message);
    return null;
  }
  
  return data;
}

/**
 * Find a profile by their MoniPay PayTag
 * @param {string} payTag - PayTag (with or without @)
 * @returns {Promise<object|null>} Profile object or null
 */
export async function getProfileByMonitag(payTag) {
  const cleanTag = payTag.replace('@', '').toLowerCase();

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('pay_tag', cleanTag) 
    .maybeSingle();
  
  if (error) {
    console.error(`❌ Error fetching profile by PayTag ${payTag}:`, error.message);
    return null;
  }
  
  return data;
}

/**
 * Get profile by wallet address
 * @param {string} walletAddress - Ethereum wallet address
 * @returns {Promise<object|null>} Profile object or null
 */
export async function getProfileByWallet(walletAddress) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('wallet_address', walletAddress)
    .maybeSingle();
  
  if (error) {
    console.error(`❌ Error fetching profile by wallet ${walletAddress}:`, error.message);
    return null;
  }
  
  return data;
}

// ============ Deduplication Checks ============

/**
 * Check if a grant has already been issued for this campaign + profile
 * This is a fast DB check before the on-chain check
 * @param {string} campaignId - Campaign ID (tweet ID)
 * @param {string} profileId - Profile UUID
 * @returns {Promise<boolean>} True if already granted
 */
export async function checkIfAlreadyGranted(campaignId, profileId) {
  const { data, error } = await supabase
    .from('campaign_grants')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('profile_id', profileId)
    .maybeSingle();
  
  if (error) {
    console.error(`❌ Error checking grant status:`, error.message);
    return false; // Fail open - let on-chain check handle it
  }
  
  return !!data;
}

/**
 * Check if a specific tweet command has already been processed
 * Prevents double payments on bot restarts/redeploys
 * @param {string} tweetId - Tweet ID
 * @returns {Promise<boolean>} True if already processed
 */
export async function checkIfCommandProcessed(tweetId) {
  const { data, error } = await supabase
    .from('monibot_transactions')
    .select('id')
    .eq('tweet_id', tweetId)
    .limit(1);
  
  if (error) {
    console.error(`❌ Error checking command status:`, error.message);
    return false; // Fail open - let on-chain check handle it
  }
  
  // Return true if any row exists for this tweet_id
  return data && data.length > 0;
}

// ============ State Updates ============

/**
 * Mark a campaign grant as issued in the database
 * @param {string} campaignId - Campaign ID (tweet ID)
 * @param {string} profileId - Profile UUID
 */
export async function markAsGranted(campaignId, profileId) {
  const { error } = await supabase
    .from('campaign_grants')
    .insert({
      campaign_id: campaignId,
      profile_id: profileId,
      granted_at: new Date().toISOString()
    });
    
  if (error) {
    console.error(`❌ Error marking grant:`, error.message);
  }
}

// ============ Transaction Logging ============

/**
 * Log a transaction to monibot_transactions
 * This is the "Silent Worker" output - the Social Agent reads this table
 * 
 * Error codes in tx_hash field (for failed transactions):
 * - AI_REJECTED: Gemini AI rejected the grant request
 * - ERROR_TARGET_NOT_FOUND: Recipient PayTag not found in database
 * - ERROR_ALLOWANCE: Sender has insufficient allowance to MoniBotRouter
 * - ERROR_BALANCE: Sender has insufficient USDC balance
 * - ERROR_DUPLICATE_TWEET: Tweet already processed (on-chain check)
 * - ERROR_DUPLICATE_GRANT: Grant already issued for this campaign+recipient
 * - ERROR_TREASURY_EMPTY: MoniBotRouter contract has insufficient USDC for grants
 * - ERROR_BLOCKCHAIN: Generic blockchain/network error
 * 
 * @param {object} params - Transaction parameters
 */
export async function logTransaction({ 
  sender_id, 
  receiver_id, 
  amount, 
  fee, 
  tx_hash, 
  campaign_id = null, 
  type,
  tweet_id = null,
  payer_pay_tag = null
}) {
  // Determine status based on tx_hash
  // If tx_hash starts with "ERROR_" or is a known error code, mark as failed
  const isError = tx_hash.startsWith('ERROR_') || 
                  tx_hash === 'AI_REJECTED' ||
                  tx_hash === 'ERROR_TARGET_NOT_FOUND';
  
  const status = isError ? 'failed' : 'completed';
  
  const { error } = await supabase
    .from('monibot_transactions')
    .insert({
      sender_id,
      receiver_id,
      amount,
      fee,
      tx_hash,
      campaign_id,
      type,                // 'grant' or 'p2p_command'
      tweet_id,            // ID of the tweet to be replied to
      payer_pay_tag,       // PayTag of the sender (for display)
      replied: false,      // Handshake flag for Social Agent
      status,              // 'completed' or 'failed'
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error('❌ Database log error:', error.message);
  } else {
    const emoji = isError ? '⚠️' : '💾';
    console.log(`${emoji} Transaction logged: ${type} | ${tx_hash.substring(0, 20)}...`);
  }
}

// ============ Campaign Management ============

/**
 * Get active campaign by tweet ID
 * @param {string} tweetId - Campaign tweet ID
 * @returns {Promise<object|null>} Campaign object or null
 */
export async function getCampaignByTweetId(tweetId) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('tweet_id', tweetId)
    .eq('status', 'active')
    .maybeSingle();
  
  if (error) {
    console.error(`❌ Error fetching campaign:`, error.message);
    return null;
  }
  
  return data;
}

/**
 * Update campaign stats after a grant
 * @param {string} campaignId - Campaign UUID
 * @param {number} grantAmount - Amount granted
 */
export async function updateCampaignStats(campaignId, grantAmount) {
  // Fetch current stats
  const { data: campaign, error: fetchError } = await supabase
    .from('campaigns')
    .select('current_participants, budget_spent')
    .eq('id', campaignId)
    .single();
  
  if (fetchError || !campaign) {
    console.error(`❌ Error fetching campaign stats:`, fetchError?.message);
    return;
  }
  
  // Update stats
  const { error: updateError } = await supabase
    .from('campaigns')
    .update({
      current_participants: (campaign.current_participants || 0) + 1,
      budget_spent: (campaign.budget_spent || 0) + grantAmount
    })
    .eq('id', campaignId);
  
  if (updateError) {
    console.error(`❌ Error updating campaign stats:`, updateError.message);
  }
}

// ============ Mission Stats ============

/**
 * Update MoniBot mission stats after a successful transaction
 * @param {number} amount - Amount spent
 */
export async function updateMissionStats(amount) {
  // Get current stats (assuming single row with id=1)
  const { data: stats, error: fetchError } = await supabase
    .from('monibot_mission_stats')
    .select('*')
    .eq('id', 1)
    .single();
  
  if (fetchError || !stats) {
    console.error(`❌ Error fetching mission stats:`, fetchError?.message);
    return;
  }
  
  // Update spent budget
  const { error: updateError } = await supabase
    .from('monibot_mission_stats')
    .update({
      spent_budget: (stats.spent_budget || 0) + amount,
      last_tweet_at: new Date().toISOString()
    })
    .eq('id', 1);
  
  if (updateError) {
    console.error(`❌ Error updating mission stats:`, updateError.message);
  }
}
