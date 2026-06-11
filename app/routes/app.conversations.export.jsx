/**
 * Admin resource route: download all chat transcripts as CSV.
 * No default export, so React Router returns the loader Response directly.
 * Fetched client-side from the conversations page (App Bridge attaches the
 * admin session token to fetch, which a plain <a download> would not have).
 */
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Quote, escape, and guard against spreadsheet formula injection.
function csvCell(value) {
  let s = String(value ?? "").replace(/"/g, '""');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return `"${s}"`;
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const messages = await prisma.message.findMany({
    orderBy: [{ conversationId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { conversationId: true, role: true, content: true, createdAt: true },
  });

  const rows = [["timestamp", "conversation_id", "role", "message"]];
  for (const msg of messages) {
    let text = msg.content;
    try {
      const blocks = JSON.parse(msg.content);
      if (Array.isArray(blocks)) {
        const texts = blocks.filter((b) => b?.type === "text").map((b) => b.text);
        const tools = blocks.filter((b) => b?.type === "tool_use").map((b) => `[called ${b.name}]`);
        text = [...texts, ...tools].join(" ");
      }
    } catch {
      // plain string content
    }
    if (!text || !text.trim()) continue; // skip tool-result payload rows
    rows.push([msg.createdAt.toISOString(), msg.conversationId, msg.role, text]);
  }

  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

  // BOM so Excel opens it as UTF-8.
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chat-transcripts.csv"',
    },
  });
};
