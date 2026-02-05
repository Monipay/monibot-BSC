import { GoogleGenerativeAI } from '@google/generative-ai';

let geminiModel;

export function initGemini() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // Using the specific model requested
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  console.log('✅ Gemini initialized');
}

export async function evaluateCampaignReply(context) {
  // Updated prompt to reference 'pay_tag' instead of 'monitag'
  const prompt = `You are MoniBot, an autonomous marketing fund manager for MoniPay.

CAMPAIGN TWEET: "${context.campaignTweet}"
REPLY: "${context.reply}"
REPLY AUTHOR: @${context.replyAuthor}
TARGET PAY TAG: @${context.targetPayTag}
IS NEW USER: ${context.isNewUser}

EVALUATION CRITERIA:
1. Does the reply genuinely participate in the campaign?
2. Is it spam or low-effort?
3. Does it deserve a grant?

GRANT RULES:
- New users (< 7 days): $0.25 - $0.50
- Existing users: $0.10 - $0.30
- High-quality engagement: +$0.10 bonus
- Spam/low-effort: $0.00

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "approved": true,
  "amount": 0.50,
  "reasoning": "New user with genuine engagement"
}`;

  try {
    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean and parse JSON
    const cleanText = text.replace(/```json|```/g, '').trim();
    const json = JSON.parse(cleanText);
    
    // Validate response structure
    if (typeof json.approved !== 'boolean' || typeof json.amount !== 'number') {
      throw new Error('Invalid response format from Gemini');
    }
    
    return json;
  } catch (error) {
    console.error('Gemini evaluation error:', error);
    // Default to rejection on error to prevent safe-fail exploits
    return {
      approved: false,
      amount: 0,
      reasoning: 'Evaluation error'
    };
  }
}
