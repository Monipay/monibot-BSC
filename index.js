import dotenv from 'dotenv';
import { initTwitterClient, pollCampaigns, pollCommands } from './twitter.js';
import { initGemini } from './gemini.js';
import { initSupabase } from './database.js';

dotenv.config();

// Validate environment variables
const requiredEnvVars = [
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_SECRET',
  'GEMINI_API_KEY',
  'MONIBOT_PRIVATE_KEY',
  'MONIBOT_PROFILE_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'MONIBOT_WALLET_ADDRESS'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

console.log('🤖 MoniBot Starting...');
console.log('📍 Profile ID:', process.env.MONIBOT_PROFILE_ID);
console.log('💰 Wallet:', process.env.MONIBOT_WALLET_ADDRESS);
console.log('⚙️  Poll Interval:', process.env.POLL_INTERVAL_MS || 60000, 'ms');

// Initialize services
initTwitterClient();
initGemini();
initSupabase();

console.log('✅ MoniBot initialized successfully!');

// Main loop
async function mainLoop() {
  try {
    console.log('\n🔄 Starting poll cycle...');
    
    // Poll for campaign replies
    if (process.env.ENABLE_CAMPAIGNS === 'true') {
      await pollCampaigns();
    }
    
    // Poll for P2P payment commands
    if (process.env.ENABLE_P2P_COMMANDS === 'true') {
      await pollCommands();
    }
    
    console.log('✅ Poll cycle complete');
  } catch (error) {
    console.error('❌ Error in main loop:', error);
  }
}

// Run immediately, then on interval
mainLoop();
setInterval(mainLoop, parseInt(process.env.POLL_INTERVAL_MS) || 60000);

console.log('🚀 MoniBot is now running!');
console.log('🚀 MoniBot is now running!');
