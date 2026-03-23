# Invoice Automation SaaS - Architecture & Implementation Plan

## Overview

Transform the invoice automation system into a hosted multi-tenant service where:
- Customers connect their Gmail via OAuth through your service
- They access invoice tracking tools through claude.ai
- You manage the infrastructure and provide ongoing service

## Business Model

**Target Customers**: Freelancers, small business owners, accountants managing multiple clients

**Pricing Tiers**:
- **Free**: 50 invoices/month, 3 ignored senders
- **Pro ($9/mo)**: Unlimited invoices, unlimited ignored senders, priority support
- **Business ($29/mo)**: Multiple Gmail accounts, team access, API access, custom integrations

## Technical Architecture

### Phase 4b: Multi-tenant Service

```
┌─────────────────┐
│  Claude.ai      │  ← Customer uses natural language
│  (End User)     │    "List my unpaid invoices"
└────────┬────────┘
         │ MCP over HTTP/SSE
         │ (API key per user)
         ▼
┌─────────────────────────┐
│  MCP Server (Your Host) │
│  ─────────────────────  │
│  • HTTP/SSE endpoint    │
│  • API key auth         │
│  • Multi-tenant router  │
│  • Rate limiting        │
│  • Usage tracking       │
└────────┬────────────────┘
         │
         ├─► PostgreSQL DB
         │   • User accounts
         │   • Gmail OAuth tokens (encrypted)
         │   • Ignored senders per user
         │   • Usage metrics
         │   • Billing info
         │
         └─► Gmail API (per-user tokens)
             • user1@gmail.com → their invoices
             • user2@gmail.com → their invoices
```

## Implementation Roadmap

### Step 1: Database Schema (PostgreSQL)

```sql
-- Users and accounts
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  tier TEXT DEFAULT 'free', -- free, pro, business
  created_at TIMESTAMP DEFAULT NOW(),
  last_active TIMESTAMP
);

-- Gmail OAuth tokens (encrypted at rest)
CREATE TABLE user_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  gmail_email TEXT NOT NULL,
  tokens_encrypted TEXT NOT NULL, -- AES-256 encrypted JSON
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, gmail_email)
);

-- Per-user ignored senders
CREATE TABLE ignored_senders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sender_pattern TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, sender_pattern)
);

-- Usage tracking for billing
CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  metadata JSONB
);

-- Stripe customer IDs
CREATE TABLE billing (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  tier TEXT DEFAULT 'free',
  billing_cycle_start DATE,
  billing_cycle_end DATE
);

CREATE INDEX idx_usage_logs_user_time ON usage_logs(user_id, timestamp);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id);
CREATE INDEX idx_ignored_senders_user ON ignored_senders(user_id);
```

### Step 2: Backend Service (Node.js/Express)

**Tech Stack**:
- **Server**: Express or Fastify
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: JWT for API keys
- **Encryption**: crypto module for token encryption
- **Payment**: Stripe for billing
- **Deployment**: Railway, Render, or Fly.io

**File Structure**:
```
invoice-automation/
├── mcp-server.js          # (current stdio version)
├── server/
│   ├── index.js           # Main HTTP server
│   ├── mcp-handler.js     # MCP over HTTP/SSE
│   ├── routes/
│   │   ├── auth.js        # OAuth flow for Gmail
│   │   ├── signup.js      # User registration
│   │   ├── webhooks.js    # Stripe webhooks
│   ├── middleware/
│   │   ├── authenticate.js # API key validation
│   │   ├── rateLimit.js   # Usage limits per tier
│   ├── services/
│   │   ├── gmail.js       # Gmail client per user
│   │   ├── encryption.js  # Token encryption
│   │   ├── billing.js     # Stripe integration
│   ├── db/
│   │   ├── schema.prisma  # Prisma schema
│   │   ├── migrations/
├── client/
│   ├── dashboard/         # React app for account management
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── Signup.tsx
│   │   │   │   ├── Dashboard.tsx
│   │   │   │   ├── Billing.tsx
│   │   │   │   ├── Settings.tsx
├── .env.example
├── docker-compose.yml
└── README.md
```

### Step 3: Core Implementation Files

#### 3.1: `server/index.js` - Main HTTP Server

```javascript
import express from 'express';
import { createMCPServer } from './mcp-handler.js';
import authRoutes from './routes/auth.js';
import { authenticate } from './middleware/authenticate.js';
import { rateLimit } from './middleware/rateLimit.js';

const app = express();
app.use(express.json());

// Public routes
app.use('/auth', authRoutes);  // OAuth flow
app.post('/signup', signupHandler);

// MCP endpoint (authenticated)
app.use('/mcp', authenticate, rateLimit);
createMCPServer(app);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Invoice Automation Service running on port ${PORT}`);
});
```

#### 3.2: `server/mcp-handler.js` - MCP over HTTP/SSE

```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getUserGmailClient } from './services/gmail.js';
import { logUsage } from './services/billing.js';

export function createMCPServer(app) {
  app.post('/mcp/messages', async (req, res) => {
    const userId = req.user.id; // From authenticate middleware

    const server = new Server({
      name: 'invoice-tracker',
      version: '1.0.0',
    }, {
      capabilities: { tools: {} },
    });

    // Set up tools (same as stdio version but with userId context)
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Log usage for billing
      await logUsage(userId, name);

      // Get user-specific Gmail client
      const gmail = await getUserGmailClient(userId);

      // Execute tool with user's Gmail account
      return await handleToolCall(name, args, gmail, userId);
    });

    // SSE transport
    const transport = new SSEServerTransport('/mcp/messages', res);
    await server.connect(transport);
  });
}
```

#### 3.3: `server/services/gmail.js` - Per-User Gmail Client

```javascript
import { google } from 'googleapis';
import { getUserTokens, updateUserTokens } from '../db/users.js';
import { decrypt } from './encryption.js';

export async function getUserGmailClient(userId) {
  const userTokens = await getUserTokens(userId);
  const tokens = decrypt(userTokens.tokens_encrypted);

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials(tokens);

  // Auto-refresh tokens
  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await updateUserTokens(userId, merged);
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}
```

#### 3.4: `server/routes/auth.js` - Gmail OAuth Flow

```javascript
import express from 'express';
import { google } from 'googleapis';
import { createUser, saveUserTokens } from '../db/users.js';
import { encrypt } from '../services/encryption.js';

const router = express.Router();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Step 1: Redirect user to Google consent screen
router.get('/gmail/authorize', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.modify'],
    prompt: 'consent',
    state: req.query.user_id, // Pass user ID through OAuth flow
  });
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback
router.get('/gmail/callback', async (req, res) => {
  const { code, state: userId } = req.query;

  const { tokens } = await oauth2Client.getToken(code);

  // Encrypt and save tokens
  const encryptedTokens = encrypt(JSON.stringify(tokens));
  await saveUserTokens(userId, encryptedTokens);

  res.redirect('/dashboard?setup=complete');
});

export default router;
```

### Step 4: Frontend Dashboard (React)

**Pages**:
1. **Landing Page**: Explain service, pricing, CTA
2. **Sign Up**: Create account, connect Gmail
3. **Dashboard**:
   - Current unpaid invoices
   - Usage stats
   - API key display
   - Connection status
4. **Settings**:
   - Manage ignored senders
   - Reconnect Gmail
   - Billing settings
5. **Billing**: Upgrade/downgrade tier, payment history

**Key Features**:
- Copy API key for MCP configuration
- One-click Gmail OAuth connection
- Real-time invoice list (using MCP tools)
- Usage graphs (for billing transparency)

### Step 5: Deployment

#### Option A: Railway (Recommended)

1. Create `railway.toml`:
```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "node server/index.js"

[env]
NODE_ENV = "production"
```

2. Add PostgreSQL database
3. Set environment variables:
   - `DATABASE_URL`
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`
   - `ENCRYPTION_KEY` (32-byte hex)
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`

4. Deploy: `railway up`

#### Option B: Render

- **Web Service**: Node.js app
- **PostgreSQL**: Managed database
- **Environment**: Same as Railway

#### Option C: Fly.io

- More control, global CDN
- `fly.toml` configuration
- Secrets management via CLI

### Step 6: Customer Onboarding Flow

1. **User signs up** at `yourdomain.com/signup`
2. **Connects Gmail** via OAuth consent screen
3. **Gets API key** displayed on dashboard
4. **Configures Claude.ai**:
   - Add MCP server: `https://yourdomain.com/mcp/messages`
   - Add header: `Authorization: Bearer <api-key>`
5. **Starts using** invoice tools in claude.ai

### Step 7: Monetization

**Stripe Integration**:
```javascript
// server/routes/webhooks.js
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case 'customer.subscription.created':
      await upgradeTier(event.data.object.customer, 'pro');
      break;
    case 'customer.subscription.deleted':
      await downgradeTier(event.data.object.customer, 'free');
      break;
  }

  res.json({ received: true });
});
```

**Usage Limits**:
```javascript
// server/middleware/rateLimit.js
export async function rateLimit(req, res, next) {
  const userId = req.user.id;
  const tier = req.user.tier;

  const thisMonthUsage = await getMonthlyUsage(userId);

  const limits = {
    free: 50,
    pro: Infinity,
    business: Infinity
  };

  if (thisMonthUsage >= limits[tier]) {
    return res.status(429).json({
      error: 'Usage limit exceeded',
      limit: limits[tier],
      current: thisMonthUsage,
      upgrade_url: '/billing/upgrade'
    });
  }

  next();
}
```

## Security Considerations

1. **Token Encryption**: AES-256-GCM for Gmail tokens at rest
2. **API Keys**: Hashed with bcrypt, never stored plain text
3. **Rate Limiting**: Per-user, per-tier limits
4. **HTTPS Only**: Force SSL in production
5. **CSRF Protection**: For web dashboard
6. **Input Validation**: Sanitize all user inputs
7. **Audit Logs**: Track all Gmail API calls per user

## Estimated Costs

**Monthly Operating Costs** (100 users):
- **Hosting** (Railway/Render): ~$20-50
- **Database** (PostgreSQL): ~$10-20
- **Domain + SSL**: ~$2-5
- **Stripe fees**: 2.9% + 30¢ per transaction
- **Total**: ~$35-75/month

**Revenue** (100 users, 50% paid):
- 50 free users: $0
- 40 Pro users: $360
- 10 Business users: $290
- **Total**: $650/month

**Profit margin**: ~90% after breakeven

## Next Steps

1. **Set up PostgreSQL database** with schema
2. **Implement OAuth flow** for Gmail (server/routes/auth.js)
3. **Convert MCP server** to HTTP/SSE transport
4. **Build user authentication** (JWT + API keys)
5. **Create React dashboard** for account management
6. **Integrate Stripe** for payments
7. **Deploy to Railway/Render**
8. **Launch beta** with initial customers

Would you like me to start implementing any of these components?
