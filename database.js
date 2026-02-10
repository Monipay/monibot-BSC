/**
 * MoniBot BSC Worker - Database Module (Supabase)
 * 
 * Identical to Base worker - shared database, same tables.
 * All BSC transactions are logged to the same monibot_transactions table.
 * Network identification is injected via metadata in the transaction log.
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
  console.log('✅ Supabase initialized (Service Role) [BSC Worker]');
}

export function getSupabase() {
  if (!supabase) {
    throw new Error('Supabase not initialized. Call initSupabase() first.');
  }
  return supabase;
}

// ============ Profile Lookups ============

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

export async function checkIfAlreadyGranted(campaignId, profileId) {
  const { data, error } = await supabase
    .from('campaign_grants')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('profile_id', profileId)
    .maybeSingle();
  
  if (error) {
    console.error(`❌ Error checking grant status:`, error.message);
    return false;
  }
  
  return !!data;
}

export async function checkIfCommandProcessed(tweetId) {
  const { data, error } = await supabase
    .from('monibot_transactions')
    .select('id')
    .eq('tweet_id', tweetId)
    .limit(1);
  
  if (error) {
    console.error(`❌ Error checking command status:`, error.message);
    return false;
  }
  
  return data && data.length > 0;
}

// ============ State Updates ============

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

export async function logTransaction({ 
  sender_id, 
  receiver_id, 
  amount, 
  fee, 
  tx_hash, 
  campaign_id = null, 
  type,
  tweet_id = null,
  payer_pay_tag = null,
  recipient_pay_tag = null
}) {
  const isError = tx_hash.startsWith('ERROR_');
  const isLimitReached = tx_hash === 'LIMIT_REACHED';
  
  const status = isError ? 'failed' : (isLimitReached ? 'limit_reached' : 'completed');
  
  const insertData = {
    sender_id,
    receiver_id,
    amount,
    fee,
    tx_hash,
    campaign_id,
    type,
    tweet_id,
    payer_pay_tag,
    recipient_pay_tag,
    replied: false,
    status,
    retry_count: 0,
    created_at: new Date().toISOString()
  };
  
  if (isError) {
    insertData.error_reason = tx_hash;
  }

  const { error } = await supabase
    .from('monibot_transactions')
    .insert(insertData);

  if (error) {
    console.error('❌ Database log error:', error.message);
  } else {
    const emoji = isError ? '⚠️' : (isLimitReached ? '⏰' : '💾');
    console.log(`${emoji} [BSC] Transaction logged: ${type} | ${tx_hash.substring(0, 20)}... | To: @${recipient_pay_tag || 'unknown'}`);
  }
}

// ============ Campaign Management ============

export async function getActiveCampaigns() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (error) {
    console.error('❌ Error fetching active campaigns:', error.message);
    return [];
  }
  
  return data || [];
}

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

export async function incrementCampaignParticipants(tweetId, grantAmount) {
  const { data: campaign, error: fetchError } = await supabase
    .from('campaigns')
    .select('id, current_participants, budget_spent, max_participants, budget_allocated')
    .eq('tweet_id', tweetId)
    .maybeSingle();
  
  if (fetchError || !campaign) {
    console.error(`❌ Error fetching campaign for update:`, fetchError?.message);
    return;
  }
  
  const newParticipants = (campaign.current_participants || 0) + 1;
  const newBudgetSpent = (campaign.budget_spent || 0) + grantAmount;
  
  const shouldComplete = 
    (campaign.max_participants && newParticipants >= campaign.max_participants) ||
    (campaign.budget_allocated && newBudgetSpent >= campaign.budget_allocated);
  
  const updateData = {
    current_participants: newParticipants,
    budget_spent: newBudgetSpent
  };
  
  if (shouldComplete) {
    updateData.status = 'completed';
    updateData.completed_at = new Date().toISOString();
  }
  
  const { error: updateError } = await supabase
    .from('campaigns')
    .update(updateData)
    .eq('id', campaign.id);
  
  if (updateError) {
    console.error(`❌ Error updating campaign stats:`, updateError.message);
  } else {
    const statusMsg = shouldComplete ? ' [COMPLETED]' : '';
    console.log(`      📊 Campaign updated: ${newParticipants} participants, $${newBudgetSpent} spent${statusMsg}`);
  }
}

export async function checkAndCompleteCampaigns() {
  const { data: activeCampaigns, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'active');
  
  if (error || !activeCampaigns) {
    console.error('Error checking campaigns:', error?.message);
    return;
  }
  
  for (const campaign of activeCampaigns) {
    let shouldComplete = false;
    let reason = '';
    
    if (campaign.max_participants && campaign.current_participants >= campaign.max_participants) {
      shouldComplete = true;
      reason = 'max_participants';
    }
    
    if (campaign.budget_allocated && campaign.budget_spent >= campaign.budget_allocated) {
      shouldComplete = true;
      reason = 'budget_exhausted';
    }
    
    if (campaign.expires_at && new Date(campaign.expires_at) < new Date()) {
      shouldComplete = true;
      reason = 'expired';
    }
    
    if (shouldComplete) {
      const { error: updateError } = await supabase
        .from('campaigns')
        .update({ 
          status: 'completed',
          completed_at: new Date().toISOString()
        })
        .eq('id', campaign.id);
      
      if (!updateError) {
        console.log(`📊 Campaign ${campaign.id.substring(0, 8)} completed (${reason})`);
      }
    }
  }
}

export async function updateCampaignStats(campaignId, grantAmount) {
  const { data: campaign, error: fetchError } = await supabase
    .from('campaigns')
    .select('current_participants, budget_spent')
    .eq('id', campaignId)
    .single();
  
  if (fetchError || !campaign) {
    console.error(`❌ Error fetching campaign stats:`, fetchError?.message);
    return;
  }
  
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

// ============ Transaction Sync to Main Ledger ============

export async function syncToMainLedger({
  senderWalletAddress,
  receiverWalletAddress,
  senderPayTag,
  receiverPayTag,
  amount,
  fee,
  txHash,
  monibotType,
  tweetId = null,
  campaignId = null,
  campaignName = null
}) {
  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/functions/v1/monibot-sync`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          action: 'logTransaction',
          senderWalletAddress,
          receiverWalletAddress,
          senderPayTag,
          receiverPayTag,
          amount,
          fee,
          txHash,
          monibotType,
          tweetId,
          campaignId,
          campaignName,
          network: 'bsc' // Network identification for multi-chain tracking
        }),
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('      ❌ Sync to main ledger failed:', errorText);
    } else {
      console.log('      📋 Synced to main transactions ledger [BSC]');
    }
  } catch (error) {
    console.error('      ❌ Sync error:', error.message);
  }
}

// ============ Mission Stats ============

export async function updateMissionStats(amount) {
  const { data: stats, error: fetchError } = await supabase
    .from('monibot_mission_stats')
    .select('*')
    .eq('id', 1)
    .single();
  
  if (fetchError || !stats) {
    console.error(`❌ Error fetching mission stats:`, fetchError?.message);
    return;
  }
  
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
