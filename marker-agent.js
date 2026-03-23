/**
 * marker-agent.js
 * 
 * Triggered when the user says "I paid X".
 * Finds the matching email with "💳 Unpaid" label and removes it.
 * Optionally applies "✅ Paid" label for an audit trail.
 * 
 * LEARNING NOTE — Agentic pattern: NL → Structured Action
 * ────────────────────────────────────────────────────────
 * The user gives a fuzzy description ("paid My OT", "the ENT invoice").
 * The agent:
 *   1. Fetches all "💳 Unpaid" emails (tool call)
 *   2. Uses Claude to match the description to the right email (LLM reasoning)
 *   3. Removes the label (tool call / state mutation)
 * 
 * This pattern — NL input → fuzzy match → precise action — is the core
 * of most practical AI agents.
 * 
 * Usage:
 *   node marker-agent.js "My OT"
 *   node marker-agent.js "ENT invoice"
 */

import Anthropic from "@anthropic-ai/sdk";
import { getGmailClient } from "./gmail-auth.js";

const UNPAID_LABEL_NAME = "💳 Unpaid";
const PAID_LABEL_NAME = "✅ Paid";

// ── Get or create a label by name ────────────────────────────────────────────

async function getOrCreateLabel(gmail, name) {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = data.labels.find(l => l.name === name);
  if (existing) return existing.id;

  const { data: newLabel } = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name }
  });
  return newLabel.id;
}

// ── Fetch all currently unpaid emails ────────────────────────────────────────

async function fetchUnpaidEmails(gmail) {
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: `label:"${UNPAID_LABEL_NAME}"`,
    maxResults: 50
  });

  if (!data.messages?.length) return [];

  return Promise.all(data.messages.map(async (msg) => {
    const { data: detail } = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"]
    });

    const getHeader = (name) =>
      detail.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

    return {
      id: msg.id,
      from: getHeader("From"),
      subject: getHeader("Subject"),
      date: getHeader("Date"),
      snippet: detail.snippet
    };
  }));
}

// ── Use Claude to match description to the right email ───────────────────────

// LEARNING NOTE: Fuzzy matching via LLM is far more robust than string matching.
// "ENT invoice", "the Bupa one", "Jessica's invoice" all resolve correctly
// because Claude understands context, not just exact strings.

const anthropic = new Anthropic();

async function matchEmailToDescription(description, emails) {
  if (emails.length === 0) return null;

  const emailList = emails.map((e, i) =>
    `[${i}] From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}`
  ).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 100,
    system: `You match a user's description to the most likely email from a list.
Return ONLY the index number (0-based) of the best match, or -1 if no match is found.
No explanation, just the number.`,
    messages: [{
      role: "user",
      content: `User said they paid: "${description}"\n\nEmails:\n${emailList}`
    }]
  });

  const index = parseInt(response.content[0].text.trim(), 10);
  if (isNaN(index) || index < 0 || index >= emails.length) return null;
  return emails[index];
}

// ── Remove "💳 Unpaid", add "✅ Paid" ────────────────────────────────────────

async function markAsPaid(gmail, messageId, unpaidLabelId, paidLabelId) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: [paidLabelId],
      removeLabelIds: [unpaidLabelId]
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const description = process.argv.slice(2).join(" ");
  if (!description) {
    console.error('Usage: node marker-agent.js "description of what you paid"');
    process.exit(1);
  }

  console.log(`\nMarking as paid: "${description}"`);

  const gmail = await getGmailClient();

  // Get label IDs
  const [unpaidLabelId, paidLabelId] = await Promise.all([
    getOrCreateLabel(gmail, UNPAID_LABEL_NAME),
    getOrCreateLabel(gmail, PAID_LABEL_NAME)
  ]);

  // Fetch unpaid emails
  const unpaidEmails = await fetchUnpaidEmails(gmail);
  console.log(`Found ${unpaidEmails.length} unpaid email(s)`);

  if (unpaidEmails.length === 0) {
    console.log("No unpaid emails found — nothing to mark.");
    return;
  }

  // Match with Claude
  const match = await matchEmailToDescription(description, unpaidEmails);

  if (!match) {
    console.log(`❌ Could not match "${description}" to any unpaid email.`);
    console.log("Current unpaid emails:");
    unpaidEmails.forEach((e, i) => console.log(`  [${i}] ${e.from} — ${e.subject}`));
    return;
  }

  // Apply label change
  await markAsPaid(gmail, match.id, unpaidLabelId, paidLabelId);
  console.log(`✅ Marked as paid: ${match.from} — ${match.subject}`);
}

run().catch(err => {
  console.error("Marker agent failed:", err);
  process.exit(1);
});
