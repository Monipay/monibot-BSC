/**
 * MoniBot BSC Worker - Scheduler Module
 * 
 * Identical to Base worker scheduler - handles scheduled jobs.
 * Same logic, shared database tables.
 */

import * as chrono from 'chrono-node';
import { getSupabase } from './database.js';
import { evaluateTimeExpression } from './gemini.js';

// ============ Time Parsing ============

export async function parseTimeExpression(text, referenceDate = new Date()) {
  const chronoResults = chrono.parse(text, referenceDate);
  
  if (chronoResults.length > 0) {
    const result = chronoResults[0];
    return {
      scheduledAt: result.start.date(),
      confidence: 'high',
      parsed: result.text,
      source: 'chrono'
    };
  }
  
  try {
    const geminiResult = await evaluateTimeExpression(text, referenceDate);
    if (geminiResult.scheduledAt) {
      return {
        scheduledAt: new Date(geminiResult.scheduledAt),
        confidence: geminiResult.confidence || 'medium',
        parsed: geminiResult.interpreted,
        source: 'gemini'
      };
    }
  } catch (error) {
    console.error('⏰ Gemini time parsing failed:', error.message);
  }
  
  return null;
}

// ============ Job Creation ============

export async function createScheduledJob({
  type,
  scheduledAt,
  payload,
  sourceTweetId,
  sourceAuthorId,
  sourceAuthorUsername
}) {
  const supabase = getSupabase();
  
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .insert({
      type,
      scheduled_at: scheduledAt.toISOString(),
      payload,
      source_tweet_id: sourceTweetId,
      source_author_id: sourceAuthorId,
      source_author_username: sourceAuthorUsername
    })
    .select()
    .single();
  
  if (error) {
    console.error('❌ Failed to create scheduled job:', error.message);
    throw error;
  }
  
  console.log(`✅ Scheduled ${type} job for ${scheduledAt.toISOString()}`);
  return data;
}

// ============ Job Polling ============

export async function getDueJobs() {
  const supabase = getSupabase();
  
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .lt('attempts', 3)
    .order('scheduled_at', { ascending: true })
    .limit(10);
  
  if (error) {
    console.error('❌ Failed to fetch due jobs:', error.message);
    return [];
  }
  
  return data || [];
}

export async function claimJob(jobId) {
  const supabase = getSupabase();
  
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      attempts: supabase.rpc ? undefined : 1
    })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select()
    .single();
  
  if (error || !data) {
    return null;
  }
  
  await supabase
    .from('scheduled_jobs')
    .update({ attempts: (data.attempts || 0) + 1 })
    .eq('id', jobId);
  
  return data;
}

export async function completeJob(jobId, result) {
  const supabase = getSupabase();
  
  await supabase
    .from('scheduled_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      result
    })
    .eq('id', jobId);
  
  console.log(`✅ Job ${jobId} completed`);
}

export async function failJob(jobId, errorMessage) {
  const supabase = getSupabase();
  
  const { data } = await supabase
    .from('scheduled_jobs')
    .select('attempts, max_attempts')
    .eq('id', jobId)
    .single();
  
  const attempts = data?.attempts || 1;
  const maxAttempts = data?.max_attempts || 3;
  
  const newStatus = attempts >= maxAttempts ? 'failed' : 'pending';
  
  await supabase
    .from('scheduled_jobs')
    .update({
      status: newStatus,
      error_message: errorMessage,
      started_at: null
    })
    .eq('id', jobId);
  
  if (newStatus === 'failed') {
    console.log(`❌ Job ${jobId} permanently failed after ${attempts} attempts`);
  } else {
    console.log(`⚠️ Job ${jobId} failed, will retry (attempt ${attempts}/${maxAttempts})`);
  }
}

// ============ Job Execution ============

async function executeRandomPick(job) {
  const { payload, source_tweet_id } = job;
  const { count, grant_amount } = payload;
  
  console.log(`🎲 Executing random pick: ${count} winners for tweet ${source_tweet_id}`);
  
  return {
    type: 'random_pick',
    count,
    grant_amount,
    source_tweet_id,
    winners: []
  };
}

async function executeCampaignPost(job) {
  const { payload } = job;
  const { message, budget, grant_amount, max_participants } = payload;
  
  console.log(`📢 Executing campaign post: "${message?.substring(0, 50)}..."`);
  
  return {
    type: 'campaign_post',
    message,
    budget,
    grant_amount,
    max_participants,
    ready_for_social: true
  };
}

export async function executeJob(job) {
  const { type } = job;
  
  switch (type) {
    case 'random_pick':
      return executeRandomPick(job);
    
    case 'campaign_post':
      return executeCampaignPost(job);
    
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

// ============ Main Scheduler Loop ============

export async function processScheduledJobs() {
  const dueJobs = await getDueJobs();
  
  if (dueJobs.length === 0) {
    return;
  }
  
  console.log(`⏰ Found ${dueJobs.length} due job(s)`);
  
  for (const job of dueJobs) {
    const claimed = await claimJob(job.id);
    if (!claimed) {
      console.log(`⏭️ Job ${job.id} already claimed, skipping`);
      continue;
    }
    
    try {
      const result = await executeJob(claimed);
      await completeJob(job.id, result);
    } catch (error) {
      console.error(`❌ Job ${job.id} failed:`, error.message);
      await failJob(job.id, error.message);
    }
  }
}

// ============ Command Parsing ============

export async function parseScheduledCommand(text) {
  const lowerText = text.toLowerCase();
  
  const randomPickMatch = lowerText.match(/pick\s+(\d+)\s+random.*?(in\s+.+|at\s+.+|tomorrow|tonight)/i);
  
  if (randomPickMatch) {
    const count = parseInt(randomPickMatch[1], 10);
    const timePhrase = randomPickMatch[2];
    
    const timeResult = await parseTimeExpression(timePhrase);
    if (!timeResult) return null;
    
    return {
      type: 'random_pick',
      count: Math.min(count, 50),
      scheduledAt: timeResult.scheduledAt,
      timePhrase: timeResult.parsed
    };
  }
  
  const campaignMatch = lowerText.match(/(post|tweet|announce).*?(in\s+.+|at\s+.+|tomorrow|tonight)/i);
  
  if (campaignMatch) {
    const timePhrase = campaignMatch[2];
    const timeResult = await parseTimeExpression(timePhrase);
    if (!timeResult) return null;
    
    return {
      type: 'campaign_post',
      scheduledAt: timeResult.scheduledAt,
      timePhrase: timeResult.parsed
    };
  }
  
  return null;
}
