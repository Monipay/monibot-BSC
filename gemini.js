import { GoogleGenerativeAI } from '@google/generative-ai';

let geminiModel;

export function initGemini() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  console.log('✅ Gemini initialized');
}

export async function evaluateCampaignReply(context) {
  const prompt = `You are MoniBot, an autonomous marketing fund manager for MoniPay.

CAMPAIGN TWEET: "${context.campaignTweet}"
REPLY: "${context.reply}"
REPLY AUTHOR: @${context.replyAuthor}
TARGET MONITAG: @${context.targetMonitag}
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
    const text = result.response.text();
    
    // Clean and parse JSON
    const cleanText = text.replace(/```json|```/g, '').trim();
    const json = JSON.parse(cleanText);
    
    // Validate
    if (typeof json.approved !== 'boolean' || typeof json.amount !== 'number') {
      throw new Error('Invalid response format');
    }
    
    return json;
  } catch (error) {
    console.error('Gemini evaluation error:', error);
    // Default to rejection on error
    return {
      approved: false,
      amount: 0,
      reasoning: 'Evaluation error'
    };
  }
}