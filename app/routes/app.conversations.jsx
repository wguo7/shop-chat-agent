/**
 * Admin: Conversations dashboard
 * Lists recent chat conversations with usage stats, behind Shopify admin auth.
 */
import { useState } from "react";
import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Matches NextLED SKUs in message text for the "top products" stat.
const SKU_RE = /\bNT-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/gi;
// Assistant deflections: the signal for knowledge-base gaps.
const NOT_SURE_RE = /not sure|connect you with|contact the nextled team|the nextled team can help|recommend (visiting|contacting)/i;

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalConversations, conversations7d, totalMessages, conversations, recentMessages] =
    await Promise.all([
      prisma.conversation.count(),
      prisma.conversation.count({ where: { createdAt: { gte: since7d } } }),
      prisma.message.count(),
      prisma.conversation.findMany({
        where: { messages: { some: {} } },
        orderBy: { updatedAt: "desc" },
        take: 50,
        include: {
          _count: { select: { messages: true } },
          messages: { where: { role: "user" }, orderBy: { createdAt: "asc" }, take: 1 },
        },
      }),
      // Last 30 days of message text for SKU mentions + "not sure" counting.
      prisma.message.findMany({
        where: { createdAt: { gte: since30d } },
        orderBy: { createdAt: "desc" },
        take: 2000,
        select: { role: true, content: true },
      }),
    ]);

  // Aggregate SKU mentions and assistant deflections.
  const skuCounts = {};
  let notSureCount = 0;
  for (const msg of recentMessages) {
    let text = msg.content;
    try {
      const parsed = JSON.parse(msg.content);
      if (Array.isArray(parsed)) {
        text = parsed.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
      }
    } catch {
      // plain string content
    }
    if (!text) continue;
    for (const m of text.matchAll(SKU_RE)) {
      const sku = m[0].toUpperCase();
      skuCounts[sku] = (skuCounts[sku] || 0) + 1;
    }
    if (msg.role === "assistant" && NOT_SURE_RE.test(text)) notSureCount++;
  }
  const topSkus = Object.entries(skuCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return {
    stats: { totalConversations, conversations7d, totalMessages, notSureCount },
    topSkus,
    conversations: conversations.map((c) => {
      let preview = c.messages[0]?.content || "";
      try {
        const parsed = JSON.parse(preview);
        if (Array.isArray(parsed)) preview = "";
      } catch {
        // plain string, keep as is
      }
      return {
        id: c.id,
        updatedAt: c.updatedAt,
        messageCount: c._count.messages,
        preview: preview.slice(0, 120),
      };
    }),
  };
};

const cellStyle = { padding: "8px 12px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };

export default function Conversations() {
  const { stats, topSkus, conversations } = useLoaderData();
  const [exportState, setExportState] = useState("idle");

  // Download via fetch so App Bridge attaches the admin session token
  // (a plain <a download> inside the embedded iframe would fail auth).
  const handleExport = async () => {
    setExportState("working");
    try {
      const res = await fetch("/app/conversations/export");
      if (!res.ok) throw new Error(`Export failed: ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "chat-transcripts.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportState("idle");
    } catch (e) {
      console.error(e);
      setExportState("error");
    }
  };

  return (
    <s-page>
      <ui-title-bar title="Chat conversations" />

      <s-section heading="Transcripts">
        <s-stack direction="inline" gap="base">
          <button
            onClick={handleExport}
            disabled={exportState === "working"}
            style={{ padding: "8px 16px", borderRadius: "8px", border: "1px solid #8a8a8a", background: "#ffffff", cursor: "pointer", fontSize: "13px" }}
          >
            {exportState === "working" ? "Preparing CSV..." : "Export all transcripts (CSV)"}
          </button>
          {exportState === "error" && <s-text tone="critical">Export failed, try again.</s-text>}
        </s-stack>
        <s-paragraph>
          <s-text tone="subdued">One row per message: timestamp, conversation ID, role, text. Opens in Excel or Google Sheets.</s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="Overview">
        <s-stack direction="inline" gap="large">
          <s-stack gap="tight">
            <s-heading>{stats.totalConversations}</s-heading>
            <s-text tone="subdued">conversations (all time)</s-text>
          </s-stack>
          <s-stack gap="tight">
            <s-heading>{stats.conversations7d}</s-heading>
            <s-text tone="subdued">conversations (7 days)</s-text>
          </s-stack>
          <s-stack gap="tight">
            <s-heading>{stats.totalMessages}</s-heading>
            <s-text tone="subdued">messages (all time)</s-text>
          </s-stack>
          <s-stack gap="tight">
            <s-heading>{stats.notSureCount}</s-heading>
            <s-text tone="subdued">"not sure" replies (30 days) — knowledge gaps</s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Most-discussed products (30 days)">
        {topSkus.length === 0 ? (
          <s-paragraph>No product mentions yet.</s-paragraph>
        ) : (
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              {topSkus.map(([sku, count]) => (
                <tr key={sku}>
                  <td style={cellStyle}><s-text>{sku}</s-text></td>
                  <td style={cellStyle}><s-text tone="subdued">{count} mentions</s-text></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>

      <s-section heading="Recent conversations">
        {conversations.length === 0 ? (
          <s-paragraph>No conversations yet.</s-paragraph>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={cellStyle}><s-text tone="subdued">When</s-text></th>
                <th style={cellStyle}><s-text tone="subdued">First question</s-text></th>
                <th style={cellStyle}><s-text tone="subdued">Messages</s-text></th>
                <th style={cellStyle}></th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((c) => (
                <tr key={c.id}>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                    <s-text>{new Date(c.updatedAt).toLocaleString()}</s-text>
                  </td>
                  <td style={cellStyle}><s-text>{c.preview || "(no text)"}</s-text></td>
                  <td style={cellStyle}><s-text>{c.messageCount}</s-text></td>
                  <td style={cellStyle}>
                    <Link to={`/app/conversations/${encodeURIComponent(c.id)}`}>View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}
