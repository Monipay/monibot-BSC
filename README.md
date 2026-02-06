# MoniBot 🤖 - Monipay's Autonomous Transaction Layer

**MoniBot** is the core Worker (Backend) for Monipay's on-chain social layer. It is a **silent, resilient** service responsible for all USDC transfers and transaction logging. Its public-facing interaction is handled by its twin: **MoniBot-VP-Social**.

## 🔗 Architecture Overview: The Two-Bot System

This project is split into two autonomous services for stability and zero-cost write access:

1.  **MoniBot (This Repo: The Worker)**: Reads Twitter, executes all blockchain transfers, and logs every outcome (success/fail) to the Supabase database.
2.  **MoniBot-VP-Social (Twin Repo: The Social Agent)**: Reads the logs created by the Worker, uses Gemini to write a personality-driven reply, and posts the reply to Twitter via the stable OAuth 2.0 API.

---

## 📂 FULL CODE BREAKDOWN (MoniBot Worker)

### 1. `index.js` (The Brain / Main Loop)
- **Function:** Coordinates all services. Runs the core loop every 60 seconds.
- Loads environment variables (`.env`).
- Initializes Twitter (read-only), Gemini, and Supabase clients.
- Runs main loop: Polls for campaign replies and P2P payment commands.

### 2. `twitter.js` (Twitter Read & Logic)
- **`pollCampaigns()`**:
    - Fetches recent campaign announcements (posted by the Social Agent).
    - Fetches and filters replies mentioning `@monitags` (`@pay_tag`).
    - Verifies reply author's X account status in Supabase.
    - Sends each valid reply to `gemini.js` for grant evaluation.
    - **Worker's Role:** Executes USDC transfer and logs the result.
- **`pollCommands()`**:
    - Searches Twitter for P2P commands (e.g., `"@monibot send $X to @user"`).
    - **Double-Spend Protection:** Checks database (`monibot_transactions`) to ensure the tweet ID hasn't been processed yet.
    - Verifies sender's X account and on-chain allowance.
    - Executes `transferFrom` on the Base blockchain.
- **Goal:** All errors (e.g., `ERROR_BALANCE`, `AI_REJECTED`) are logged to the database instead of being replied to directly.

### 3. `gemini.js` (AI Decision Making)
- **`evaluateCampaignReply()`**:
    - Sends campaign/reply context to **Gemini 2.5 Flash**.
    - **Logic:** AI evaluates if the reply deserves a grant based on engagement quality.
    - **Output:** `{approved: true/false, amount: 0.00-0.50, reasoning: "..."}`
    - *Note:* A rejection logs `tx_hash: 'AI_REJECTED'`.

### 4. `blockchain.js` (USDC Transfers on Base)
- **`transferUSDC(toAddress, amount)`** (For Grants): Transfers USDC from MoniBot's treasury.
- **`transferFromUSDC(fromAddress, toAddress, amount, fee)`** (For P2P):
    - Transfers USDC using the sender's pre-approved allowance.
    - **Safety:** Performs a pre-flight `balanceOf` check to prevent blockchain crashes.
    - Transfers the fee to the **Official Monipay Fee Wallet** (`0xDC9B...`).
- **`getOnchainAllowance(userAddress)`**: Checks user's allowance for MoniBot.

### 5. `database.js` (Supabase Queries & Logging)
- **`logTransaction(...)`**: **The Core Handshake.** Logs all outcomes to the `monibot_transactions` table with:
    - `tx_hash`: The real hash (Success) OR an error code (`ERROR_BALANCE`, `AI_REJECTED`).
    - `tweet_id`: The ID of the tweet to be replied to.
    - `replied`: Set to `FALSE`. (The trigger for the Social Agent).
- **`checkIfCommandProcessed()`**: Prevents double-spending by checking if a `tweet_id` already exists in logs.
- `getProfileByMonitag()`: Resolves user handles (`@monitag` is stored as `pay_tag`).

---

## ⚙️ HOW THE TWO-BOT SYSTEM WORKS

### 📢 Campaign Flow (Worker + Social Agent)
1. **[VP-Social Agent]** **Tweets Campaign:** "First 5 people to drop their @paytag get $1!"
2. **[User]** Replies: "@alice @bob thanks!"
3. **[Worker Bot (This Repo)]** Polls Twitter, verifies user, sends to Gemini.
4. **[Worker Bot]** Executes `transferUSDC` (e.g., $0.99 net).
5. **[Worker Bot]** Logs to DB: `tx_hash: 0xabc...`, `replied: FALSE`, `tweet_id: REPLY_ID`.
6. **[VP-Social Agent]** Polls DB, sees `replied: FALSE`.
7. **[VP-Social Agent]** Uses Gemini to generate reply: *"✅ Sent! Welcome to the onchain economy 🔵 TX: 0xabc...*
8. **[VP-Social Agent]** Posts reply via OAuth 2.0 API, then flips DB `replied: TRUE`.

### 💸 P2P Command Flow (Worker + Social Agent)
1. **[User]** Tweets: `"@monibot send $5 to @jade"`
2. **[Worker Bot]** Verifies allowance, balance, and target existence.
3. **[Worker Bot]** Executes `transferFromUSDC` (e.g., $4.95 net + $0.05 fee to Monipay Wallet).
4. **[Worker Bot]** Logs to DB: `tx_hash: 0xxyz...`, `replied: FALSE`, `tweet_id: COMMAND_ID`.
5. **[VP-Social Agent]** Polls DB, sees `replied: FALSE`.
6. **[VP-Social Agent]** Posts reply: *"✅ @user sent $4.95 to @jade! TX: 0xxyz..."*
7. **[VP-Social Agent]** Flips DB `replied: TRUE`.

---

## 🛠️ Deployment Notes

### Repository Recommendation:
**YES.** Both repositories should be public and linked to demonstrate the decoupled, robust, and modern architecture.

- **Link MoniBot-VP-Social's README** to the MoniBot Worker repository.
- **Link MoniBot Worker's README** to the MoniBot-VP-Social repository.

### Environment Variables:
- **Worker (This Repo):** Uses Twitter **Read-Only** keys.
- **Social Agent (Twin Repo):** Uses Twitter **OAuth 2.0 (Read & Write)** credentials.
