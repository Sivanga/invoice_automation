#!/usr/bin/env node
/**
 * test-mcp.js
 *
 * Quick test of MCP server functionality before connecting to Claude Code.
 * Tests: Gmail auth, list unpaid, ignored senders management
 */

import { getGmailClient } from "./gmail-auth.js";
import fs from "fs/promises";

const UNPAID_LABEL_NAME = "💳 Unpaid";
const IGNORED_SENDERS_FILE = "./ignored-senders.json";

console.log("🧪 Testing MCP Server Components\n");

// Test 1: Gmail Authentication
console.log("1️⃣  Testing Gmail authentication...");
try {
  const gmail = await getGmailClient();
  console.log("   ✅ Gmail auth successful\n");

  // Test 2: Check for unpaid label
  console.log("2️⃣  Checking for '💳 Unpaid' label...");
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const unpaidLabel = data.labels.find(l => l.name === UNPAID_LABEL_NAME);

  if (unpaidLabel) {
    console.log(`   ✅ Found label: ${UNPAID_LABEL_NAME} (ID: ${unpaidLabel.id})`);

    // Test 3: Count unpaid invoices
    console.log("\n3️⃣  Counting unpaid invoices...");
    const { data: messages } = await gmail.users.messages.list({
      userId: "me",
      q: `label:"${UNPAID_LABEL_NAME}"`,
      maxResults: 10
    });

    const count = messages.messages?.length || 0;
    console.log(`   📧 Found ${count} unpaid invoice(s)`);

    if (count > 0) {
      console.log("   \n   First few:");
      for (const msg of messages.messages.slice(0, 3)) {
        const { data: detail } = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject"]
        });
        const from = detail.payload.headers.find(h => h.name === "From")?.value || "";
        const subject = detail.payload.headers.find(h => h.name === "Subject")?.value || "";
        console.log(`   • ${from.substring(0, 40)} - ${subject.substring(0, 40)}`);
      }
    }
  } else {
    console.log(`   ⚠️  Label "${UNPAID_LABEL_NAME}" not found (will be created on first use)`);
  }

  // Test 4: Ignored senders file
  console.log("\n4️⃣  Checking ignored senders...");
  const senders = JSON.parse(await fs.readFile(IGNORED_SENDERS_FILE, "utf8"));
  console.log(`   ✅ Loaded ${senders.length} ignored sender(s):`);
  senders.forEach(s => console.log(`      - ${s}`));

  console.log("\n✅ All tests passed! MCP server is ready to use.\n");
  console.log("📋 Next steps:");
  console.log("   1. Configure Claude Code MCP settings (see instructions below)");
  console.log("   2. Restart Claude Code");
  console.log("   3. Try: 'List my unpaid invoices'\n");

} catch (error) {
  console.error("\n❌ Test failed:", error.message);

  if (error.message.includes("No token.json")) {
    console.log("\n💡 Run this first to authenticate:");
    console.log("   node gmail-auth.js");
  } else if (error.message.includes("invalid_grant")) {
    console.log("\n💡 Token expired. Re-authenticate:");
    console.log("   node gmail-auth.js");
  } else {
    console.error("\nFull error:", error);
  }
  process.exit(1);
}

// Print MCP configuration
console.log("═".repeat(70));
console.log("📝 Claude Code MCP Configuration");
console.log("═".repeat(70));
console.log("\nAdd this to your MCP settings:\n");
console.log("File: ~/.claude/mcp_settings.json\n");
console.log(JSON.stringify({
  mcpServers: {
    "invoice-tracker": {
      command: "node",
      args: [process.cwd() + "/mcp-server.js"]
    }
  }
}, null, 2));
console.log("\n" + "═".repeat(70) + "\n");
