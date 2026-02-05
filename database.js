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

export async function getProfileByMonitag(monitag) {
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .ilike('monitag', monitag)
    .single();
  
  return data;
}

export async function checkIfAlreadyGranted(campaignId, profileId) {
  const { data } = await supabase
    .from('campaign_grants')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('profile_id', profileId)
    .single();
  
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

export async function logTransaction({ sender_id, receiver_id, amount, fee, tx_hash, campaign_id, type }) {
  await supabase
    .from('transactions')
    .insert({
      sender_id,
      receiver_id,
      amount,
      fee,
      tx_hash,
      campaign_id,
      type,
      status: 'completed',
      created_at: new Date().toISOString()
    });
}