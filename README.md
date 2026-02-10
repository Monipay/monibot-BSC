# MoniBot BSC Worker 🤖⛓️ - BNB Smart Chain Transaction Layer

**MoniBot BSC Worker** is the BSC-specific fork of the MoniBot Silent Worker. It executes USDT transactions on BNB Smart Chain via the **MoniBotRouter** contract.

---

## 🔗 Key Differences from Base Worker

| Aspect | Base Worker | BSC Worker |
|--------|------------|------------|
| Chain | Base Mainnet (8453) | BSC Mainnet (56) |
| Token | USDC | USDT |
| Decimals | 6 | 18 |
| Router | `0xBEE37c2f3Ce9a48D498FC0D47629a1E10356A516` | `0x9EED3cF32690FfFaD0b8BB44CaC65B3B801c832E` |
| RPC Env | `BASE_RPC_URL` | `BSC_RPC_URL` |
| Auto-Restart | None | 90 minutes (OAuth refresh) |
| Database | Shared | Shared (same Supabase) |

---

## 🏗️ Contract Details

```
MoniBotRouter (BSC): 0x9EED3cF32690FfFaD0b8BB44CaC65B3B801c832E
USDT (BSC):          0x55d398326f99059fF775485246999027B3197955
MoniPayRouter (BSC): 0x557285AbC46038E898d90eB00943Ff42c4Fbcb54
Treasury:            0xDC9B47551734bE984D7Aa2a365251E002f8FF2D7
Chain:               BSC Mainnet (56)
```

---

## 🔐 Environment Variables

```bash
# Twitter API (Read-Only for Worker)
TWITTER_API_KEY=your_api_key
TWITTER_API_SECRET=your_api_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_SECRET=your_access_secret

# AI (Campaign Evaluation)
GEMINI_API_KEY=your_gemini_key

# Blockchain (Executor Wallet - must be authorized on BSC MoniBotRouter)
MONIBOT_PRIVATE_KEY=0x...
BSC_RPC_URL=https://bsc-dataseed.binance.org

# Database (Shared with Base Worker)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key

# Bot Identity
MONIBOT_PROFILE_ID=uuid-of-monibot-profile
MONIBOT_WALLET_ADDRESS=0x...

# Optional
POLL_INTERVAL_MS=60000
ENABLE_CAMPAIGNS=true
ENABLE_P2P_COMMANDS=true
```

---

## 🚀 Deployment (Railway)

1. **Create a new Railway service** (separate from Base worker)

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set environment variables** in Railway dashboard

4. **Authorize the Executor on BSC:**
   ```solidity
   // Call from contract owner wallet on BSC
   MoniBotRouter.addExecutor(MONIBOT_WALLET_ADDRESS)
   ```

5. **Fund the BSC Router** (for grants):
   ```
   Send USDT to: 0x9EED3cF32690FfFaD0b8BB44CaC65B3B801c832E
   ```

6. **Fund the executor wallet with BNB** for gas fees

7. **Start:**
   ```bash
   npm start
   ```

---

## 📊 Console Output

```
🤖 MoniBot BSC Worker Starting...

┌─────────────────────────────────────────────────┐
│        MoniBot BSC Silent Worker v1.0          │
│     Router-Based + DB-Driven (USDT/BSC)       │
└─────────────────────────────────────────────────┘

📋 Configuration:
   Chain:            BSC Mainnet (56)
   Token:            USDT (18 decimals)
   Router Address:   0x9EED3cF32690FfFaD0b8BB44CaC65B3B801c832E
   Auto-Restart:     90 minutes

✅ All services initialized successfully!

🔄 [12:00:00] Poll Cycle #1 [BSC]
────────────────────────────────────
📊 [BSC] Polling for campaign replies...
💬 [BSC] Polling for P2P commands...
────────────────────────────────────
✅ Cycle #1 complete. Next in 60s
```

---

**Built with 💙 on BNB Smart Chain**
