/**
 * MoniBot BSC Worker - AI Module (Gemini)
 * 
 * Same as Base worker but system prompt explicitly states BSC/USDT context.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let geminiModel;

// ============ Initialization ============

export function initGemini() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  geminiModel = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 256,
    }
  });
  
  console.log('✅ Gemini AI initialized (gemini-1.5-flash) [BSC Worker]');
}

// ============ Campaign Evaluation ============

export async function evaluateCampaignReply(context) {
  const prompt = buildEvaluationPrompt(context);

  try {
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    const evaluation = parseEvaluationResponse(text);
    
    console.log(`      🧠 AI Decision: ${evaluation.approved ? '✅ Approved' : '❌ Rejected'} ($${evaluation.amount})`);
    console.log(`         Reason: ${evaluation.reasoning}`);
    
    return evaluation;
    
  } catch (error) {
    console.error('❌ Gemini evaluation error:', error.message);
    
    return {
      approved: false,
      amount: 0,
      reasoning: `AI evaluation failed: ${error.message}`
    };
  }
}

// ============ Prompt Building ============

function buildEvaluationPrompt(context) {
  return `You are MoniBot, an autonomous marketing fund manager for MoniPay (a gasless payment app). You are operating on BNB Smart Chain (BSC) using USDT.

Your job is to evaluate campaign replies and decide if they deserve a USDT grant.

=== CONTEXT ===
CAMPAIGN TWEET: "${context.campaignTweet}"
REPLY: "${context.reply}"
REPLY AUTHOR: @${context.replyAuthor}
TARGET PAY_TAG: @${context.targetPayTag}
IS NEW USER: ${context.isNewUser ? 'Yes (joined < 7 days ago)' : 'No (existing user)'}
CHAIN: BNB Smart Chain (BSC)
TOKEN: USDT (18 decimals)

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
  let cleanText = text
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .replace(/^\s*\n/gm, '')
    .trim();
  
  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleanText = jsonMatch[0];
  }
  
  try {
    const json = JSON.parse(cleanText);
    
    if (typeof json.approved !== 'boolean') {
      throw new Error('Missing or invalid "approved" field');
    }
    if (typeof json.amount !== 'number' || json.amount < 0) {
      throw new Error('Missing or invalid "amount" field');
    }
    if (typeof json.reasoning !== 'string') {
      json.reasoning = json.approved ? 'Approved by AI' : 'Rejected by AI';
    }
    
    json.amount = Math.min(Math.max(json.amount, 0), 1.0);
    
    if (!json.approved) {
      json.amount = 0;
    }
    
    return json;
    
  } catch (parseError) {
    console.error('❌ Failed to parse AI response:', parseError.message);
    console.error('   Raw text:', cleanText.substring(0, 200));
    
    return {
      approved: false,
      amount: 0,
      reasoning: 'Failed to parse AI evaluation response'
    };
  }
}

// ============ Utility Functions ============

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
