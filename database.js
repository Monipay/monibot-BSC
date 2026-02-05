import { createClient } from '@supabase/supabase-js';

let supabase;

export function initSupabase() {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  console.log('✅ Supabase initialized');
}

export async function getProfileByXUsername(xUsername) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .ilike('x_username', xUsername)
    .eq('x_verified', true)
    .single();
  
  return data;
}

/**
 * Finds a profile by their Monitag (stored as pay_tag in DB)
 */
export async function getProfileByMonitag(payTag) {
  // Removing '@' if passed in the argument to ensure clean search
  const cleanTag = payTag.replace('@', '');

  const { data } = await supabase
    .from('profiles')
    .select('*')
    .ilike('pay_tag', cleanTag) 
    .single();
  
  return data;
}

export async function checkIfAlreadyGranted(campaignId, profileId) {
  const { data } = await supabase
    .from('campaign_grants')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('profile_id', profileId)
    .maybeSingle(); // Used maybeSingle to handle 'not found' gracefully
  
  return !!data;
}

/**
 * NEW: Checks if a specific P2P tweet command has already been processed.
 * This prevents double payments on bot restarts/redeploys.
 */
export async function checkIfCommandProcessed(tweetId) {
  const { data } = await supabase
    .from('monibot_transactions')
    .select('id')
    .eq('tweet_id', tweetId)
    .maybeSingle();
  
  return !!data;
}

export async function markAsGranted(campaignId, profileId) {
  await supabase
    .from('campaign_grants')
    .insert({
      campaign_id: campaignId,
      profile_id: profileId,
      granted_at: new Date().toISOString()
    });
}

/**
 * Logs a transaction to monibot_transactions.
 * Includes tweet_id and payer_pay_tag for the OpenClaw Growth Agent.
 */
export async function logTransaction({ 
  sender_id, 
  receiver_id, 
  amount, 
  fee, 
  tx_hash, 
  campaign_id, 
  type,
  tweet_id,
  payer_pay_tag
}) {
  const { error } = await supabase
    .from('monibot_transactions')
    .insert({
      sender_id,
      receiver_id,
      amount,
      fee,
      tx_hash,
      campaign_id,
      type,
      tweet_id,        // ID of the tweet to be replied to
      payer_pay_tag,   // Monitag of the sender
      replied: false,  // Handshake for OpenClaw Social Agent
      status: 'completed',
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error('❌ Database log error:', error.message);
  } else {
    console.log('💾 Transaction logged successfully for OpenClaw.');
  }
}
