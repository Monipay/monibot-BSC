# MoniBot - Monipay's Social Layer & VP of Growth 🤖

## 📂 FULL CODE BREAKDOWN

### 1. `index.js` (Main Bot Loop)
Think of it as the "brain" that coordinates everything.
- Loads environment variables.
- Initializes Twitter, Gemini, and Supabase clients.
- **Runs main loop every 60 seconds:**
  - Polls for campaign replies.
  - Polls for P2P payment commands.

### 2. `twitter.js` (Twitter Integration)
**`pollCampaigns()`**
- Gets MoniBot's recent tweets (campaign announcements) Openclaw Agent.
- For each campaign tweet, fetches all replies.
- Filters replies that mention `@monitags`.
- Verifies reply author has verified X account in Monipay Supabase.
- Sends each valid reply to Gemini for evaluation.
- If approved, transfers USDC and logs transaction.

**`pollCommands()`**
- Searches Twitter for `"@monibot send $X to @user"` or `"@monibot pay @user $X"`.
- Verifies sender has verified X account.
- Checks sender's on-chain allowance.
- Executes `transferFrom` (using sender's pre-approved allowance).
- Replies with transaction confirmation.

### 3. `gemini.js` (AI Decision Making)
**`evaluateCampaignReply()`**
- Sends campaign context to Gemini Flash 3.0.
- AI evaluates if reply deserves a grant.
- **Returns:** `{approved: true/false, amount: 0.00-0.50, reasoning: "..."}`
- Prevents spam/low-effort replies from getting grants.
- Rewards genuine engagement.

### 4. `blockchain.js` (USDC Transfers on Base)
**`transferUSDC(toAddress, amount)`**
- Used for **campaign grants**.
- Transfers USDC from MoniBot's wallet to recipient.
- Waits for blockchain confirmation.

**`transferFromUSDC(fromAddress, toAddress, amount, fee)`**
- Used for **P2P commands**.
- Transfers USDC using sender's pre-approved allowance.
- Also transfers 1% fee to MoniBot.

**`getOnchainAllowance(userAddress)`**
- Checks how much USDC a user has approved for MoniBot to spend.
- Used to validate P2P commands.

### 5. `database.js` (Supabase Queries)
- `getProfileByXUsername()`: Finds MoniPay user by their verified X username.
- `getProfileByMonitag()`: Finds MoniPay user by their `@monitag`.
- `checkIfAlreadyGranted()`: Prevents duplicate grants in same campaign.
- `markAsGranted()`: Records that a user received a grant.
- `logTransaction()`: Saves transaction details to database.

### 6. `package.json`
- Lists all dependencies (libraries) the bot needs.
- Railway uses this to install required packages.

### 7. `.env.example`
- Template showing which environment variables are needed.
- **Note:** You DON'T use this file directly - it's just documentation. Actual secrets go in Railway's environment variables.

### 8. `.gitignore`
- Tells Git to NOT commit sensitive files (`.env`, `node_modules`).
- Prevents accidentally exposing your API keys on GitHub.

---

## ⚙️ HOW THE BOT WORKS (Full Flow)

### 📢 Campaign Flow
1. **OpenClaw Agent tweets:** "First 5 people to drop their @monitag get $1!"
   ↓
2. **Users reply:** "@alice @bob thanks!"
   ↓
3. **Bot (every 60s):**
   - Fetches your campaign tweet
   - Gets all replies
   - Extracts @monitags from each reply
   ↓
4. **For each @monitag:**
   - Check: Does @monitag exist in MoniPay?
   - Check: Has reply author verified their X account?
   - Check: Already granted in this campaign?
   ↓
5. **Send to Gemini AI:**
   - "Should we give @alice a grant?"
   - AI returns: `{approved: true, amount: 0.50}`
   ↓
6. **Execute transfer:**
   - Transfer 0.495 USDC to @alice (0.50 - 1% fee)
   - Keep 0.005 USDC as fee
   ↓
7. **Log and reply:**
   - Save transaction in database
   - Reply: "✅ Sent $0.495 to @alice! TX: 0xabc..."

### 💸 P2P Command Flow
1. **User tweets:** "@monibot send $5 to @jade"
   ↓
2. **Bot verifies:**
   - Does sender have verified X account?
   - Does sender have $5+ allowance approved?
   - Does @jade exist on MoniPay?
   ↓
3. **Execute transferFrom:**
   - Transfer $4.95 from sender to @jade
   - Transfer $0.05 fee to MoniBot
   ↓
4. **Reply:** "✅ @user sent $4.95 to @jade! TX: 0x..."
   - Transfer $0.05 fee to MoniBot
   ↓
4. **Reply:** "✅ @user sent $4.95 to @jade! TX: 0x..."
