/**
 * MoniBot Scheduler - Temporal Intelligence Module
 * 
 * Handles scheduled jobs like:
 * - Random picks ("pick 5 random people in 5 hours")
 * - Campaign posts (scheduled tweets)
 * - Reminders
 * 
 * Uses chrono-node for natural language time parsing
 * and Gemini for complex time expressions.
 */

import * as chrono from 'chrono-node';
import { getSupabase } from './database.js';
import { evaluateTimeExpression } from './gemini.js';

// ============ Time Parsing ============

/**
 * Parse natural language time expression to a Date
 * Uses chrono-node first, falls back to Gemini for complex expressions
 * 
 * @param {string} text - Natural language text containing time
 * @param {Date} referenceDate - Reference date for relative times
 * @returns {Promise<{scheduledAt: Date, confidence: string, parsed: string}>}
 */
export async function parseTimeExpression(text, referenceDate = new Date()) {
  // Try chrono-node first (fast, local)
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
  
  // Fall back to Gemini for complex expressions
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

/**
 * Create a scheduled job
 * 
 * @param {Object} params
 * @param {string} params.type - Job type: 'random_pick', 'campaign_post', 'reminder'
 * @param {Date} params.scheduledAt - When to execute
 * @param {Object} params.payload - Job-specific data
 * @param {string} params.sourceTweetId - Tweet that triggered this job
 * @param {string} params.sourceAuthorId - Twitter user ID
 * @param {string} params.sourceAuthorUsername - Twitter username
 */
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

/**
 * Get all jobs that are due for execution
 * 
 * @returns {Promise<Array>} Array of due jobs
 */
export async function getDueJobs() {
  const supabase = getSupabase();
  
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .lt('attempts', 3) // Don't retry too many times
    .order('scheduled_at', { ascending: true })
    .limit(10);
  
  if (error) {
    console.error('❌ Failed to fetch due jobs:', error.message);
    return [];
  }
  
  return data || [];
}

/**
 * Mark job as processing (claim it)
 */
export async function claimJob(jobId) {
  const supabase = getSupabase();
  
  const { data, error } = await supabase
    .from('scheduled_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      attempts: supabase.rpc ? undefined : 1 // Increment handled below
    })
    .eq('id', jobId)
    .eq('status', 'pending') // Only claim if still pending
    .select()
    .single();
  
  if (error || !data) {
    // Job was claimed by another worker or doesn't exist
    return null;
  }
  
  // Increment attempts
  await supabase
    .from('scheduled_jobs')
    .update({ attempts: (data.attempts || 0) + 1 })
    .eq('id', jobId);
  
  return data;
}

/**
 * Mark job as completed
 */
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

/**
 * Mark job as failed
 */
export async function failJob(jobId, errorMessage) {
  const supabase = getSupabase();
  
  const { data } = await supabase
    .from('scheduled_jobs')
    .select('attempts, max_attempts')
    .eq('id', jobId)
    .single();
  
  const attempts = data?.attempts || 1;
  const maxAttempts = data?.max_attempts || 3;
  
  // If we've hit max attempts, mark as failed permanently
  const newStatus = attempts >= maxAttempts ? 'failed' : 'pending';
  
  await supabase
    .from('scheduled_jobs')
    .update({
      status: newStatus,
      error_message: errorMessage,
      started_at: null // Clear started_at so it can be retried
    })
    .eq('id', jobId);
  
  if (newStatus === 'failed') {
    console.log(`❌ Job ${jobId} permanently failed after ${attempts} attempts`);
  } else {
    console.log(`⚠️ Job ${jobId} failed, will retry (attempt ${attempts}/${maxAttempts})`);
  }
}

// ============ Job Execution ============

/**
 * Execute a random pick job
 * Picks N random users who replied to a tweet
 */
async function executeRandomPick(job) {
  const { payload, source_tweet_id } = job;
  const { count, grant_amount } = payload;
  
  console.log(`🎲 Executing random pick: ${count} winners for tweet ${source_tweet_id}`);
  
  // This will be implemented in twitter.js
  // For now, return the job config
  return {
    type: 'random_pick',
    count,
    grant_amount,
    source_tweet_id,
    // Winners will be populated by the execution logic
    winners: []
  };
}

/**
 * Execute a campaign post job
 * Posts a scheduled tweet/campaign
 */
async function executeCampaignPost(job) {
  const { payload } = job;
  const { message, budget, grant_amount, max_participants } = payload;
  
  console.log(`📢 Executing campaign post: "${message?.substring(0, 50)}..."`);
  
  // This will be implemented by VP-Social
  // Worker just marks the job as ready for VP-Social to pick up
  return {
    type: 'campaign_post',
    message,
    budget,
    grant_amount,
    max_participants,
    ready_for_social: true
  };
}

/**
 * Main job executor
 */
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

/**
 * Process all due jobs
 * Called from the main worker loop
 */
export async function processScheduledJobs() {
  const dueJobs = await getDueJobs();
  
  if (dueJobs.length === 0) {
    return;
  }
  
  console.log(`⏰ Found ${dueJobs.length} due job(s)`);
  
  for (const job of dueJobs) {
    // Try to claim the job
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

/**
 * Parse a scheduled command from a tweet
 * Example: "@monibot pick 5 random people in 5 hours"
 * 
 * @param {string} text - Tweet text
 * @returns {Promise<Object|null>} Parsed command or null
 */
export async function parseScheduledCommand(text) {
  const lowerText = text.toLowerCase();
  
  // Pattern: pick N random in TIME
  const randomPickMatch = lowerText.match(/pick\s+(\d+)\s+random.*?(in\s+.+|at\s+.+|tomorrow|tonight)/i);
  
  if (randomPickMatch) {
    const count = parseInt(randomPickMatch[1], 10);
    const timePhrase = randomPickMatch[2];
    
    const timeResult = await parseTimeExpression(timePhrase);
    if (!timeResult) return null;
    
    return {
      type: 'random_pick',
      count: Math.min(count, 50), // Cap at 50
      scheduledAt: timeResult.scheduledAt,
      timePhrase: timeResult.parsed
    };
  }
  
  // Pattern: post/tweet in TIME
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
