# Payment Scan — Invoice Agent System

Automatically detects, tracks, and clears invoices in Gmail using Claude agents.

## Architecture

```
DETECTOR AGENT (daily cron)
  → scans last 24h emails
  → classifies with Claude
  → applies "💳 Unpaid" Gmail label

SCANNER SKILL (claude.ai)
  → searches label:"💳 Unpaid"
  → shows table with links

MARKER AGENT (CLI)
  → npm run paid "My OT"
  → Claude fuzzy-matches description
  → removes "💳 Unpaid", adds "✅ Paid"
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add your credentials
```bash
cp /path/to/your/client_secret.json credentials.json
```

### 3. Authenticate (one-time)
```bash
npm run auth
# Opens browser → approve → token.json saved automatically
```

### 4. Test the detector
```bash
npm run detect
```

### 5. Add to cron (daily at 8am)
```bash
crontab -e
0 8 * * * cd /path/to/payment-scan && node detector-agent.js >> logs/detector.log 2>&1
```

## Usage

```bash
# Mark as paid (fuzzy match via Claude)
npm run paid "My OT"
npm run paid "ENT invoice"

# Check unpaid in claude.ai
# Just say: "check for invoices"
```

## Files

| File | Purpose |
|---|---|
| `gmail-auth.js` | OAuth2 flow + token management |
| `detector-agent.js` | Daily cron — labels new invoices |
| `marker-agent.js` | Marks invoices as paid |
| `credentials.json` | Your OAuth client secret ⚠️ don't commit |
| `token.json` | Auto-generated tokens ⚠️ don't commit |

## .gitignore
```
credentials.json
token.json
logs/
node_modules/
```
