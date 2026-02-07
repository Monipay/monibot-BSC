/**
 * MoniBot Worker - AI Module (Gemini)
 * 
 * This module uses Google Gemini to evaluate campaign replies.
 * It determines if a reply deserves a grant and how much.
 * 
 * Uses direct Gemini API (not Lovable AI Gateway) since this runs
 * on an external server, not Supabase Edge Functions.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let geminiModel;

// ============ Initialization ============

export function initGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  // Using Gemini 2.0 Flash for fast, cost-effective evaluation
  geminiModel = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.3, // Lower temperature for more consistent decisions
      maxOutputTokens: 256,
    }
  });
  
  console.log('✅ Gemini AI initialized (gemini-1.5-flash)');
}

// ============ Campaign Evaluation ============

/**
 * Evaluate a campaign reply to determine grant eligibility
 * 
 * @param {object} context - Evaluation context
 * @param {string} context.campaignTweet - The original campaign tweet text
 * @param {string} context.reply - The user's reply text
 * @param {string} context.replyAuthor - Twitter username of the reply author
 * @param {string} context.targetPayTag - PayTag mentioned in the reply
 * @param {boolean} context.isNewUser - Whether the target is a new user (< 7 days)
 * @returns {Promise<{approved: boolean, amount: number, reasoning: string}>}
 */
export async function evaluateCampaignReply(context) {
  const prompt = buildEvaluationPrompt(context);

  try {
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Parse and validate response
    const evaluation = parseEvaluationResponse(text);
    
    console.log(`      🧠 AI Decision: ${evaluation.approved ? '✅ Approved' : '❌ Rejected'} ($${evaluation.amount})`);
    console.log(`         Reason: ${evaluation.reasoning}`);
    
    return evaluation;
    
  } catch (error) {
    console.error('❌ Gemini evaluation error:', error.message);
    
    // Safe-fail: Reject on error to prevent exploitation
    return {
      approved: false,
      amount: 0,
      reasoning: `AI evaluation failed: ${error.message}`
    };
  }
}

// ============ Prompt Building ============

function buildEvaluationPrompt(context) {
  return `You are MoniBot, an autonomous marketing fund manager for MoniPay (a gasless USDC payment app on Base).

Your job is to evaluate campaign replies and decide if they deserve a USDC grant.

=== CONTEXT ===
CAMPAIGN TWEET: "${context.campaignTweet}"
REPLY: "${context.reply}"
REPLY AUTHOR: @${context.replyAuthor}
TARGET PAY_TAG: @${context.targetPayTag}
IS NEW USER: ${context.isNewUser ? 'Yes (joined < 7 days ago)' : 'No (existing user)'}

=== EVALUATION CRITERIA ===
1. Does the reply genuinely engage with the campaign? (not just "nice" or emoji spam)
2. Is the @paytag mention intentional and meaningful?
3. Is this spam, bot behavior, or low-effort farming?
4. Would rewarding this reply encourage quality engagement?

=== GRANT TIERS ===
- REJECT ($0.00): Spam, bots, low-effort, off-topic, or suspicious
- MINIMAL ($0.10): Basic participation, existing user
- STANDARD ($0.25): Good engagement, new user bonus
- QUALITY ($0.50): Exceptional engagement, creative, helpful
- MAXIMUM ($1.00): Outstanding contribution (rare)

=== ANTI-GAMING RULES ===
- Self-tagging (author tags themselves): REJECT
- Repeated/template replies: REJECT  
- Single word/emoji only: REJECT
- Obvious bot patterns: REJECT

=== RESPONSE FORMAT ===
Respond with ONLY valid JSON (no markdown, no backticks, no explanation):
{"approved": true, "amount": 0.25, "reasoning": "Brief 1-sentence explanation"}

Your decision:`;
}

// ============ Response Parsing ============

function parseEvaluationResponse(text) {
  // Clean the response text
  let cleanText = text
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .replace(/^\s*\n/gm, '')
    .trim();
  
  // Try to extract JSON if there's extra text
  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleanText = jsonMatch[0];
  }
  
  try {
    const json = JSON.parse(cleanText);
    
    // Validate required fields
    if (typeof json.approved !== 'boolean') {
      throw new Error('Missing or invalid "approved" field');
    }
    if (typeof json.amount !== 'number' || json.amount < 0) {
      throw new Error('Missing or invalid "amount" field');
    }
    if (typeof json.reasoning !== 'string') {
      json.reasoning = json.approved ? 'Approved by AI' : 'Rejected by AI';
    }
    
    // Clamp amount to valid range
    json.amount = Math.min(Math.max(json.amount, 0), 1.0);
    
    // If not approved, amount must be 0
    if (!json.approved) {
      json.amount = 0;
    }
    
    return json;
    
  } catch (parseError) {
    console.error('❌ Failed to parse AI response:', parseError.message);
    console.error('   Raw text:', cleanText.substring(0, 200));
    
    // Return safe default
    return {
      approved: false,
      amount: 0,
      reasoning: 'Failed to parse AI evaluation response'
    };
  }
}

// ============ Utility Functions ============

/**
 * Test the Gemini connection with a simple prompt
 * Useful for debugging connection issues
 */
export async function testGeminiConnection() {
  try {
    const result = await geminiModel.generateContent('Reply with just "OK" if you can read this.');
    const response = await result.response;
    const text = response.text().trim();
    
    console.log('🧪 Gemini test response:', text);
    return text.toLowerCase().includes('ok');
  } catch (error) {
    console.error('❌ Gemini connection test failed:', error.message);
    return false;
  }
}

// ============ Time Expression Parsing ============

/**
 * Evaluate a natural language time expression using Gemini
 * Used as fallback when chrono-node can't parse the expression
 * 
 * @param {string} text - Text containing time expression
 * @param {Date} referenceDate - Reference date for relative times
 * @returns {Promise<{scheduledAt: string, interpreted: string, confidence: string}>}
 */
export async function evaluateTimeExpression(text, referenceDate = new Date()) {
  const prompt = `You are a time parser. Extract the scheduled time from the following text.

TEXT: "${text}"
CURRENT DATE/TIME: ${referenceDate.toISOString()}

Examples:
- "in 5 hours" → 5 hours from now
- "tomorrow at 3pm" → next day at 15:00
- "tonight" → today at 20:00
- "in 30 minutes" → 30 minutes from now

Respond with ONLY valid JSON (no markdown):
{"scheduledAt": "ISO-8601 datetime string", "interpreted": "human readable interpretation", "confidence": "high|medium|low"}

If you cannot parse a time, respond with:
{"scheduledAt": null, "interpreted": "could not parse", "confidence": "none"}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean and parse response
    let cleanText = text
      .replace(/```json\n?/gi, '')
      .replace(/```\n?/g, '')
      .trim();
    
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return { scheduledAt: null, interpreted: 'parse failed', confidence: 'none' };
  } catch (error) {
    console.error('❌ Gemini time parsing error:', error.message);
    return { scheduledAt: null, interpreted: error.message, confidence: 'none' };
  }
}
