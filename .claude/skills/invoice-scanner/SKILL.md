---
name: scan-invoices
description: >
  Scan Gmail for new invoices, list unpaid bills, and manage payment status.
  Also tracks manual invoices (e.g. from WhatsApp) stored locally.
  Triggers on: "scan for invoices", "check unpaid bills", "find new invoices",
  "what do I owe", "mark as paid", "ignore sender", "add invoice".
---

# Invoice Scanner

When the user invokes this skill, follow this workflow:

## Important: Use Gmail MCP tools directly

The `invoice-tracker` MCP server tools are NOT available in Claude Code sessions. Use Gmail MCP tools directly.

## Step 1: Load data and search Gmail (in parallel)

Do ALL of these in a single parallel tool call:
- Read the ignored senders list from `ignored-senders.json` in the project root
- Read the manual invoices list from `manual-invoices.json` in the project root
- Run ONE combined Gmail search: `gmail_search_messages(q="(label:💳 Unpaid) OR (newer_than:24h subject:(invoice OR bill OR \"balance due\" OR \"amount due\" OR \"payment required\" OR overdue OR \"pay now\"))")`

## Step 2: Filter and categorize results

- Filter out any emails from ignored senders — never show them in the table or mention them as examples
- Categorize remaining emails: those with `💳 Unpaid` in their `labelIds` are "tracked unpaid", the rest are "newly detected"
- From `manual-invoices.json`, collect entries where `"status": "unpaid"` — these are "manual unpaid"

## Step 3: Present results

Combine the filtered results into a clear markdown table. Include both Gmail and manual invoices:

```
| # | From | Subject | Amount | Due Date | How to Pay |
|---|------|---------|--------|----------|------------|
| 1 | ...  | ...     | ...    | ...      | ...        |
```

- For Gmail invoices: populate From/Subject/Date from the email. For "How to Pay", use the `htmlLink` from the Gmail search result to link to the email (e.g. `[View email](htmlLink)`). If the email snippet contains a payment link, include that too.
- For manual invoices: show `[manual] Sender` in the From column, use description as Subject, show amount and due date. For "How to Pay", use the `paymentDetails` field from the JSON entry if it exists.
- If new invoices were detected in Step 2, note how many were newly found vs. already tracked

If there are no unpaid invoices (after filtering), say so clearly.

## Step 4: Offer actions

After presenting the table, offer these actions:

- **Mark as paid**: "Tell me which invoice you paid and I'll mark it"
- **Ignore a sender**: "Want me to ignore a sender so their emails aren't flagged?"
- **Add invoice**: "Got a WhatsApp invoice? Tell me the details and I'll track it (e.g. '£50 to plumber for boiler repair, due April 1')"

Do NOT use ignored senders as examples in action prompts. Use generic examples or names from the current results instead.

## Action handlers

### Mark as paid
- **Gmail invoices**: Use `gmail_read_message` to get the thread, then apply the `✅ Paid` label and remove `💳 Unpaid` label (note: label changes require the MCP server; inform the user if not available)
- **Manual invoices**: Read `manual-invoices.json`, find the matching entry by from/description, set its `"status"` to `"paid"`, and write the file back

### Ignore a sender
Read `ignored-senders.json`, add the new sender name (lowercase), and write the file back.

### Add manual invoice
When the user says something like "add £50 plumber invoice, due April 1" or provides invoice details:
1. Parse the natural language to extract: **from** (who it's from), **description** (what for), **amount** (with currency), **dueDate** (YYYY-MM-DD format), and **paymentDetails** (bank details, payment link, or any payment instructions — if provided)
2. Read `manual-invoices.json`
3. Append a new entry:
   ```json
   {
     "id": "<timestamp in ms>",
     "from": "<sender>",
     "description": "<what the invoice is for>",
     "amount": "<amount with currency symbol>",
     "dueDate": "<YYYY-MM-DD>",
     "addedDate": "<today YYYY-MM-DD>",
     "status": "unpaid",
     "paymentDetails": "<how to pay — bank transfer details, payment link, etc. Omit if not provided>"
   }
   ```
4. Write the updated array back to `manual-invoices.json`
5. Confirm to the user what was added

### Summarize pasted invoice
When the user pastes raw invoice text/data, extract and present:
- **Title**: What the invoice is for
- **Amount**: Total due with currency
- **How to pay**: Payment method/details from the invoice

Then ask if they want to add it to tracking.
