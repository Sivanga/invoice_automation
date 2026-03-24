---
name: scan-invoices
description: >
  Scan Gmail for new invoices, list unpaid bills, and manage payment status.
  Triggers on: "scan for invoices", "check unpaid bills", "find new invoices",
  "what do I owe", "mark as paid", "ignore sender".
---

# Invoice Scanner

When the user invokes this skill, follow this workflow:

## Step 1: Detect new invoices

Call the `detect_invoices` MCP tool (from the `invoice-tracker` server) to scan recent Gmail for new invoices. Use the default 24-hour window unless the user specifies otherwise.

## Step 2: List all unpaid invoices

Call the `list_unpaid` MCP tool to get the full list of currently unpaid invoices (including any just detected).

## Step 3: Present results

Combine the results into a clear markdown table:

```
| # | From | Subject | Date |
|---|------|---------|------|
| 1 | ...  | ...     | ...  |
```

If new invoices were detected in Step 1, note how many were newly found vs. already tracked.

If there are no unpaid invoices, say so clearly.

## Step 4: Offer actions

After presenting the table, offer these actions:

- **Mark as paid**: "Tell me which invoice you paid and I'll mark it (e.g., 'I paid the Bupa invoice')"
- **Ignore a sender**: "Want me to ignore a sender so their emails aren't flagged? (e.g., 'ignore Apple')"

When the user asks to mark something as paid, call the `mark_paid` tool with their description.
When the user asks to ignore a sender, call the `add_ignored_sender` tool with the sender name.
