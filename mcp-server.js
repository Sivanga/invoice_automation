#!/usr/bin/env node
/**
 * mcp-server.js
 *
 * MCP server for invoice tracking system.
 * Exposes tools for managing unpaid invoices via Gmail labels.
 *
 * Usage (local stdio):
 *   node mcp-server.js
 *
 * Architecture:
 * - Core: Gmail operations + ignored sender management
 * - Transport: stdio (Phase 4a) → HTTP/SSE (Phase 4b)
 * - Future: Multi-tenant OAuth (each user connects their own Gmail)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Anthropic from "@anthropic-ai/sdk";
import { getGmailClient } from "./gmail-auth.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

const UNPAID_LABEL_NAME = "💳 Unpaid";
const PAID_LABEL_NAME = "✅ Paid";
const IGNORED_SENDERS_FILE = path.join(__dirname, "ignored-senders.json");

const anthropic = new Anthropic();

// ── Ignored Senders Management ───────────────────────────────────────────────

async function loadIgnoredSenders() {
  try {
    const data = await fs.readFile(IGNORED_SENDERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") {
      // File doesn't exist, return empty array
      return [];
    }
    throw err;
  }
}

async function saveIgnoredSenders(senders) {
  await fs.writeFile(
    IGNORED_SENDERS_FILE,
    JSON.stringify(senders, null, 2),
    "utf8"
  );
}

async function addIgnoredSender(name) {
  const senders = await loadIgnoredSenders();
  const normalized = name.toLowerCase().trim();

  if (senders.some(s => s.toLowerCase() === normalized)) {
    return { success: false, message: `"${name}" is already in the ignore list` };
  }

  senders.push(normalized);
  await saveIgnoredSenders(senders);
  return { success: true, message: `Added "${name}" to ignore list` };
}

async function removeIgnoredSender(name) {
  const senders = await loadIgnoredSenders();
  const normalized = name.toLowerCase().trim();
  const filtered = senders.filter(s => s.toLowerCase() !== normalized);

  if (filtered.length === senders.length) {
    return { success: false, message: `"${name}" not found in ignore list` };
  }

  await saveIgnoredSenders(filtered);
  return { success: true, message: `Removed "${name}" from ignore list` };
}

// ── Gmail Helper Functions ───────────────────────────────────────────────────

async function fetchRecentEmails(gmail, hoursBack = 24) {
  const queries = [
    `newer_than:${hoursBack}h subject:(invoice OR invoicing OR inv OR bill OR "balance due" OR "amount due" OR "payment required" OR overdue OR "pay now") -label:"${UNPAID_LABEL_NAME}"`,
    `newer_than:${hoursBack}h -label:"${UNPAID_LABEL_NAME}" in:inbox`
  ];

  const allMessages = new Map();

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

async function fetchUnpaidEmails(gmail) {
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: `label:"${UNPAID_LABEL_NAME}"`,
    maxResults: 100
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

// ── Claude Integration ───────────────────────────────────────────────────────

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

// ── MCP Tool Implementations ─────────────────────────────────────────────────

const tools = [
  {
    name: "detect_invoices",
    description: "Scan recent Gmail messages, classify them with Claude, and label new invoices as '💳 Unpaid'. Returns a summary of newly detected invoices.",
    inputSchema: {
      type: "object",
      properties: {
        hours_back: {
          type: "number",
          description: "How many hours back to search (default: 24)"
        }
      },
      required: []
    }
  },
  {
    name: "scan_invoices",
    description: "Search Gmail for emails labeled '💳 Unpaid' and return a structured list of unpaid invoices",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "mark_paid",
    description: "Mark an invoice as paid by providing a description. Uses fuzzy matching to find the right email and removes the '💳 Unpaid' label, adding '✅ Paid' label",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Natural language description of the invoice (e.g., 'My OT', 'ENT invoice', 'Bupa bill')"
        }
      },
      required: ["description"]
    }
  },
  {
    name: "list_unpaid",
    description: "Fast lookup to return count and list of all unpaid invoices",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "add_ignored_sender",
    description: "Add a sender name to the ignore list. Emails from ignored senders won't be automatically labeled as unpaid invoices",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name or partial email of sender to ignore (e.g., 'apple', 'netflix', 'gym@example.com')"
        }
      },
      required: ["name"]
    }
  },
  {
    name: "remove_ignored_sender",
    description: "Remove a sender from the ignore list",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of sender to remove from ignore list"
        }
      },
      required: ["name"]
    }
  }
];

async function handleToolCall(name, args) {
  const gmail = await getGmailClient();

  switch (name) {
    case "detect_invoices": {
      const hoursBack = args.hours_back || 24;

      const messages = await fetchRecentEmails(gmail, hoursBack);

      if (messages.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              detected: 0,
              message: `No candidate emails found in the last ${hoursBack} hours`,
              invoices: []
            }, null, 2)
          }]
        };
      }

      const details = await Promise.all(
        messages.map(m => fetchMessageDetails(gmail, m.id))
      );

      const ignoredSenders = await loadIgnoredSenders();
      const filtered = details.filter(e => {
        const fromLower = e.from.toLowerCase();
        return !ignoredSenders.some(s => fromLower.includes(s));
      });

      if (filtered.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              detected: 0,
              message: "All candidate emails were from ignored senders",
              invoices: []
            }, null, 2)
          }]
        };
      }

      const invoiceIndices = await classifyWithClaude(filtered);
      const invoices = invoiceIndices.map(i => filtered[i]).filter(Boolean);

      const labelId = await getOrCreateLabel(gmail, UNPAID_LABEL_NAME);
      for (const email of invoices) {
        await applyUnpaidLabel(gmail, email.id, labelId);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            detected: invoices.length,
            scanned: messages.length,
            hours_back: hoursBack,
            invoices: invoices.map(e => ({
              from: e.from,
              subject: e.subject,
              date: e.date,
              snippet: e.snippet
            }))
          }, null, 2)
        }]
      };
    }

    case "scan_invoices":
    case "list_unpaid": {
      const emails = await fetchUnpaidEmails(gmail);
      const ignoredSenders = await loadIgnoredSenders();

      // Filter out ignored senders
      const filtered = emails.filter(e => {
        const fromLower = e.from.toLowerCase();
        return !ignoredSenders.some(s => fromLower.includes(s));
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            count: filtered.length,
            invoices: filtered.map(e => ({
              from: e.from,
              subject: e.subject,
              date: e.date,
              snippet: e.snippet
            }))
          }, null, 2)
        }]
      };
    }

    case "mark_paid": {
      const { description } = args;

      if (!description?.trim()) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Description is required"
            })
          }]
        };
      }

      const unpaidEmails = await fetchUnpaidEmails(gmail);

      if (unpaidEmails.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "No unpaid emails found"
            })
          }]
        };
      }

      const match = await matchEmailToDescription(description, unpaidEmails);

      if (!match) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: `Could not match "${description}" to any unpaid email`,
              available: unpaidEmails.map(e => ({
                from: e.from,
                subject: e.subject
              }))
            })
          }]
        };
      }

      const [unpaidLabelId, paidLabelId] = await Promise.all([
        getOrCreateLabel(gmail, UNPAID_LABEL_NAME),
        getOrCreateLabel(gmail, PAID_LABEL_NAME)
      ]);

      await markAsPaid(gmail, match.id, unpaidLabelId, paidLabelId);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: "Marked as paid",
            invoice: {
              from: match.from,
              subject: match.subject,
              date: match.date
            }
          })
        }]
      };
    }

    case "add_ignored_sender": {
      const { name } = args;

      if (!name?.trim()) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Sender name is required"
            })
          }]
        };
      }

      const result = await addIgnoredSender(name);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result)
        }]
      };
    }

    case "remove_ignored_sender": {
      const { name } = args;

      if (!name?.trim()) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Sender name is required"
            })
          }]
        };
      }

      const result = await removeIgnoredSender(name);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result)
        }]
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server Setup ─────────────────────────────────────────────────────────

async function runServer() {
  const server = new Server(
    {
      name: "invoice-tracker",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      return await handleToolCall(name, args || {});
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: error.message
          })
        }],
        isError: true
      };
    }
  });

  // Start server with stdio transport (Phase 4a)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("Invoice Tracker MCP server running on stdio");
  console.error("Tools available: detect_invoices, scan_invoices, mark_paid, list_unpaid, add_ignored_sender, remove_ignored_sender");
}

// ── Main ─────────────────────────────────────────────────────────────────────

runServer().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
