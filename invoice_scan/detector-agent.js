/**
 * detector-agent.js
 * 
 * Runs daily (cron). Scans the last 24h of email, classifies invoices
 * using Claude, and applies the "💳 Unpaid" Gmail label to matches.
 * 
 * LEARNING NOTE — Agentic pattern: Tool-Use Loop
 * ─────────────────────────────────────────────
 * This agent follows the ReAct pattern:
 *   Reason → Act (call tool) → Observe result → Reason again → ...
 * 
 * The loop here is:
 *   1. Search Gmail (tool call)
 *   2. For each email: ask Claude "is this an invoice?" (LLM reasoning)
 *   3. If yes: apply label via Gmail API (tool call)
 *   4. Log what was done (observe)
 * 
 * Cron (daily at 8am):
 *   0 8 * * * cd /path/to/payment-scan && node detector-agent.js >> logs/detector.log 2>&1
 */

import Anthropic from "@anthropic-ai/sdk";
import { getGmailClient } from "./gmail-auth.js";

// ── Config ───────────────────────────────────────────────────────────────────

const UNPAID_LABEL_NAME = "💳 Unpaid";

// Senders whose invoice emails are informational copies — never actionable
const IGNORED_SENDERS = [
  "apple", "pembridge dental", "edf", "bt", "courtfit"
];

// ── Step 1: Ensure the "💳 Unpaid" label exists, return its ID ───────────────

async function getOrCreateLabel(gmail) {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = data.labels.find(l => l.name === UNPAID_LABEL_NAME);
  if (existing) return existing.id;

  console.log(`Creating label "${UNPAID_LABEL_NAME}"...`);
  const { data: newLabel } = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name: UNPAID_LABEL_NAME }
  });
  return newLabel.id;
}

// ── Step 2: Search Gmail for last 24h emails ─────────────────────────────────

async function fetchRecentEmails(gmail) {
  // Two searches to maximize coverage:
  // A) Broad invoice keyword search
  // B) General inbox (catches invoicing platforms with non-obvious subjects)
  const queries = [
    `newer_than:1d subject:(invoice OR invoicing OR inv OR bill OR "balance due" OR "amount due" OR "payment required" OR overdue OR "pay now") -label:"${UNPAID_LABEL_NAME}"`,
    `newer_than:1d -label:"${UNPAID_LABEL_NAME}" in:inbox`
  ];

  const allMessages = new Map(); // deduplicate by message ID

  for (const q of queries) {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 50
    });
    for (const msg of data.messages || []) {
      allMessages.set(msg.id, msg);
    }
  }

  return [...allMessages.values()];
}

// ── Step 3: Fetch full message details ───────────────────────────────────────

async function fetchMessageDetails(gmail, messageId) {
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"]
  });

  const getHeader = (name) =>
    data.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  return {
    id: messageId,
    threadId: data.threadId,
    from: getHeader("From"),
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    snippet: data.snippet
  };
}

// ── Step 4: Ask Claude if this email is an actionable invoice ────────────────

// LEARNING NOTE: This is the "reasoning" step in the agent loop.
// We give Claude just enough context (from, subject, snippet) to classify
// without reading the full body — keeps it fast and cheap.

const anthropic = new Anthropic();

async function classifyWithClaude(emails) {
  if (emails.length === 0) return [];

  const emailList = emails.map((e, i) =>
    `[${i}] From: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
  ).join("\n\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    system: `You are classifying emails to determine if they require the recipient to make a payment.

Return ONLY a JSON array of indices (0-based) of emails that are actionable invoices.

INCLUDE: invoices, bills, payment due notices, subscription renewals, overdue notices, 
         insurance excess letters, invoicing platform emails (Xero, QuickBooks, Stripe, etc.)
         Subjects with patterns like "INV-1234", "GBP 450.00", "due date"

EXCLUDE: promotions, receipts for already-paid transactions, newsletters,
         "you've been paid" notifications, marketing, general announcements

Return format: [0, 2, 5] or [] if none qualify. No explanation, just the JSON array.`,
    messages: [{
      role: "user",
      content: `Classify these emails:\n\n${emailList}`
    }]
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    console.error("Failed to parse Claude classification:", text);
    return [];
  }
}

// ── Step 5: Apply "💳 Unpaid" label ──────────────────────────────────────────

// LEARNING NOTE: This is the "act" step — mutating state in Gmail.
// gmail.users.messages.modify can add AND remove labels in one call.
// We use this same API in the Marker Agent to remove the label.

async function applyUnpaidLabel(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds: []
    }
  });
}

// ── Main agent loop ──────────────────────────────────────────────────────────

async function run() {
  console.log(`\n[${new Date().toISOString()}] Detector agent starting...`);

  const gmail = await getGmailClient();
  const labelId = await getOrCreateLabel(gmail);

  // Fetch
  const messages = await fetchRecentEmails(gmail);
  console.log(`Found ${messages.length} candidate emails in last 24h`);

  if (messages.length === 0) {
    console.log("Nothing to process.");
    return;
  }

  // Get details for each
  const details = await Promise.all(
    messages.map(m => fetchMessageDetails(gmail, m.id))
  );

  // Filter out ignored senders before calling Claude
  const filtered = details.filter(e => {
    const fromLower = e.from.toLowerCase();
    return !IGNORED_SENDERS.some(s => fromLower.includes(s));
  });

  console.log(`After filtering ignored senders: ${filtered.length} emails to classify`);

  if (filtered.length === 0) {
    console.log("All emails were from ignored senders.");
    return;
  }

  // Classify with Claude
  const invoiceIndices = await classifyWithClaude(filtered);
  const invoices = invoiceIndices.map(i => filtered[i]);

  console.log(`Claude identified ${invoices.length} actionable invoice(s)`);

  // Apply label to each
  for (const email of invoices) {
    await applyUnpaidLabel(gmail, email.id, labelId);
    console.log(`  ✅ Labeled: [${email.date.slice(0, 16)}] ${email.from} — ${email.subject}`);
  }

  console.log(`[${new Date().toISOString()}] Done.\n`);
}

run().catch(err => {
  console.error("Detector agent failed:", err);
  process.exit(1);
});
