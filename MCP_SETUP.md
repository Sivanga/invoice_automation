# Invoice Tracker MCP Server

A Model Context Protocol (MCP) server that exposes your automated invoice tracking system to Claude via tools.

## Features

- **scan_invoices**: Search for all unpaid invoices
- **mark_paid**: Mark an invoice as paid using natural language description
- **list_unpaid**: Quick count and list of unpaid invoices
- **add_ignored_sender**: Add senders to the ignore list
- **remove_ignored_sender**: Remove senders from the ignore list

## Phase 4a: Local Setup (stdio transport)

### Prerequisites

1. Gmail OAuth credentials already configured (`credentials.json` + `token.json`)
2. Node.js installed
3. Dependencies installed: `npm install`

### Connecting to Claude Code

Add this to your Claude Code MCP settings:

**~/.claude/mcp_settings.json**:

```json
{
  "mcpServers": {
    "invoice-tracker": {
      "command": "node",
      "args": ["/Users/sivangalamidi/Development/gmail/mcp-server.js"]
    }
  }
}
```

### Testing the Server

1. Start Claude Code
2. The server will automatically connect via stdio
3. Try asking Claude: "List my unpaid invoices"
4. Or: "Mark the OT invoice as paid"

### Tools Available

#### scan_invoices / list_unpaid
Returns structured JSON with all unpaid invoices (filtered by ignored senders).

```json
{
  "count": 3,
  "invoices": [
    {
      "from": "billing@example.com",
      "subject": "Invoice #1234",
      "date": "Mon, 20 Jan 2025",
      "snippet": "Your invoice for £450 is due..."
    }
  ]
}
```

#### mark_paid
Takes a natural language description and fuzzy matches to the right email.

Input:
```json
{
  "description": "My OT"
}
```

Output:
```json
{
  "success": true,
  "message": "Marked as paid",
  "invoice": {
    "from": "ot@clinic.com",
    "subject": "Invoice - Occupational Therapy",
    "date": "Mon, 20 Jan 2025"
  }
}
```

#### add_ignored_sender
Adds a sender to the persistent ignore list.

Input:
```json
{
  "name": "netflix"
}
```

#### remove_ignored_sender
Removes a sender from the ignore list.

## Phase 4b: Multi-tenant Service (Future)

To deploy as a hosted service for multiple users:

1. **Transport**: Switch from stdio to HTTP with Server-Sent Events (SSE)
2. **Authentication**:
   - Implement user accounts
   - Add OAuth flow per user (store tokens in database per user_id)
   - Add API key authentication for MCP clients
3. **Database**:
   - Store user credentials securely
   - Store per-user ignored senders
   - Store audit logs
4. **Deployment**:
   - Deploy to cloud platform (Render, Railway, Fly.io)
   - Set up SSL/TLS
   - Configure environment variables for secrets

### Architecture for Phase 4b

```
┌─────────────┐
│ Claude.ai   │
│ (customer)  │
└──────┬──────┘
       │ MCP over HTTP/SSE
       │ (authenticated with API key)
       ▼
┌─────────────────────────┐
│  MCP Server (hosted)    │
│  - HTTP/SSE transport   │
│  - Multi-tenant routing │
│  - User auth            │
└──────┬──────────────────┘
       │
       │ per-user OAuth tokens
       ▼
┌─────────────┐
│ Gmail API   │
│ (user's     │
│  account)   │
└─────────────┘
```

### Implementation Steps for Phase 4b

1. Create database schema:
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE,
  api_key TEXT UNIQUE,
  gmail_tokens JSONB,
  ignored_senders JSONB,
  created_at TIMESTAMP
);
```

2. Add HTTP server (Express/Fastify)
3. Implement OAuth flow endpoint for Gmail
4. Add user authentication middleware
5. Modify tool handlers to use per-user Gmail clients
6. Deploy with environment variables for secrets

## Current Status

✅ Phase 4a (Local): Complete
- stdio transport working
- All 5 tools implemented
- Reuses existing gmail-auth.js
- Persistent ignored senders in JSON file

⬜ Phase 4b (Service): Planned
- HTTP/SSE transport
- Multi-tenant OAuth
- Database for user data
- Cloud deployment
