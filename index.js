/**
 * MoniBot Worker - Entry Point (Router Architecture)
 * 
 * This is the main entry point for the Silent Worker Bot.
 * It polls Twitter for campaign replies and P2P commands,
 * then executes transactions via the MoniBotRouter contract.
 * 
 * Architecture:
 * - Silent Worker: Does NOT reply via Twitter API
 * - All results logged to monibot_transactions table
 * - Separate Social Agent handles Twitter replies
 * 
 * v3.0 - Added:
 * - Campaign auto-completion check in main loop
 * - DB-driven campaign polling
 * - Transaction mirroring to main ledger
 * 
 * Required Environment Variables:
 * - TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
 * - MONIBOT_PRIVATE_KEY (Executor wallet - must be authorized on MoniBotRouter)
 * - MONIBOT_PROFILE_ID (Bot's profile UUID in database)
 * - MONIBOT_WALLET_ADDRESS (Bot's wallet address for ledger sync)
 * - SUPABASE_URL, SUPABASE_SERVICE_KEY
 * - BASE_RPC_URL (Base Mainnet RPC endpoint)
 */

import dotenv from 'dotenv';
import { initTwitterClient, pollCampaigns, pollCommands } from './twitter.js';
import { initGemini } from './gemini.js';
import { initSupabase, checkAndCompleteCampaigns } from './database.js';
import { MONIBOT_ROUTER_ADDRESS } from './blockchain.js';
import { processScheduledJobs } from './scheduler.js';

dotenv.config();

// ============ Configuration ============

const requiredEnvVars = [
  // Twitter API
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_SECRET',
  
  // Blockchain (Executor wallet)
  'MONIBOT_PRIVATE_KEY',
  'BASE_RPC_URL',
  
  // Database
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  
  // Bot identity
  'MONIBOT_PROFILE_ID'
];

// Optional env vars with defaults
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 60000;
const CAMPAIGN_CHECK_INTERVAL_MS = parseInt(process.env.CAMPAIGN_CHECK_INTERVAL_MS) || 300000; // 5 min
const ENABLE_CAMPAIGNS = process.env.ENABLE_CAMPAIGNS !== 'false'; // Default: true
const ENABLE_P2P_COMMANDS = process.env.ENABLE_P2P_COMMANDS !== 'false'; // Default: true

// ============ Validation ============

console.log('🤖 MoniBot Worker Starting (Router Architecture v3.0)...\n');

// Check required environment variables
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Missing required environment variables:');
  missingVars.forEach(v => console.error(`   - ${v}`));
  process.exit(1);
}

// ============ Startup Banner ============

console.log('┌─────────────────────────────────────────────────┐');
console.log('│           MoniBot Silent Worker v3.0           │');
console.log('│       Router-Based + DB-Driven Architecture    │');
console.log('└─────────────────────────────────────────────────┘\n');

console.log('📋 Configuration:');
console.log(`   Profile ID:       ${process.env.MONIBOT_PROFILE_ID}`);
console.log(`   Router Address:   ${MONIBOT_ROUTER_ADDRESS}`);
console.log(`   RPC Endpoint:     ${process.env.BASE_RPC_URL.substring(0, 40)}...`);
console.log(`   Poll Interval:    ${POLL_INTERVAL_MS}ms`);
console.log(`   Campaign Check:   ${CAMPAIGN_CHECK_INTERVAL_MS}ms`);
console.log(`   Campaigns:        ${ENABLE_CAMPAIGNS ? '✅ Enabled' : '❌ Disabled'}`);
console.log(`   P2P Commands:     ${ENABLE_P2P_COMMANDS ? '✅ Enabled' : '❌ Disabled'}`);
console.log('');

// ============ Initialization ============

try {
  initTwitterClient();
  initGemini();
  initSupabase();
  console.log('\n✅ All services initialized successfully!\n');
} catch (error) {
  console.error('❌ Failed to initialize services:', error.message);
  process.exit(1);
}

// ============ Main Loop ============

let cycleCount = 0;
let lastCampaignCheck = 0;

async function mainLoop() {
  cycleCount++;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  
  try {
    console.log(`\n🔄 [${timestamp}] Poll Cycle #${cycleCount}`);
    console.log('─'.repeat(40));
    
    // Poll for campaign replies (grants from contract balance)
    if (ENABLE_CAMPAIGNS) {
      await pollCampaigns();
    }
    
    // Poll for P2P payment commands (from user allowances)
    if (ENABLE_P2P_COMMANDS) {
      await pollCommands();
    }
    
    // Process scheduled jobs (random picks, campaign posts, etc.)
    await processScheduledJobs();
    
    // Check campaign completion (less frequently)
    const now = Date.now();
    if (now - lastCampaignCheck > CAMPAIGN_CHECK_INTERVAL_MS) {
      await checkAndCompleteCampaigns();
      lastCampaignCheck = now;
    }
    
    console.log('─'.repeat(40));
    console.log(`✅ Cycle #${cycleCount} complete. Next in ${POLL_INTERVAL_MS / 1000}s`);
    
  } catch (error) {
    console.error('❌ Error in main loop:', error.message);
    // Don't exit - continue to next cycle
  }
}

// ============ Graceful Shutdown ============

process.on('SIGINT', () => {
  console.log('\n\n🛑 Received SIGINT. Shutting down gracefully...');
  console.log(`📊 Completed ${cycleCount} poll cycles.`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n🛑 Received SIGTERM. Shutting down gracefully...');
  console.log(`📊 Completed ${cycleCount} poll cycles.`);
  process.exit(0);
});

// ============ Start ============

console.log('🚀 MoniBot is now running!');
console.log('   Press Ctrl+C to stop.\n');

// Run immediately, then on interval
mainLoop();
setInterval(mainLoop, POLL_INTERVAL_MS);
