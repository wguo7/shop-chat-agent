/**
 * Admin: single conversation transcript, behind Shopify admin auth.
 */
import { useState } from "react";
import { useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }) => {
  await authenticate.admin(request);

  const messages = await prisma.message.findMany({
    where: { conversationId: params.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Flatten each stored message into displayable items: text, tool calls,
  // and tool results (tool result payloads are noisy, so just label them).
  const items = [];
  for (const msg of messages) {
    let blocks;
    try {
      blocks = JSON.parse(msg.content);
    } catch {
      blocks = null;
    }
    if (!Array.isArray(blocks)) {
      items.push({ kind: msg.role, text: msg.content, at: msg.createdAt });
      continue;
    }
    for (const block of blocks) {
      if (block?.type === "text" && block.text?.trim()) {
        items.push({ kind: msg.role, text: block.text, at: msg.createdAt });
      } else if (block?.type === "tool_use") {
        items.push({ kind: "tool", text: `Called ${block.name}: ${JSON.stringify(block.input)}`.slice(0, 300), at: msg.createdAt });
      } else if (block?.type === "tool_result") {
        items.push({ kind: "tool", text: "Tool result received", at: msg.createdAt });
      }
    }
  }

  return { conversationId: params.id, items };
};

const bubbleBase = {
  padding: "10px 14px",
  borderRadius: "10px",
  maxWidth: "75%",
  whiteSpace: "pre-wrap",
  fontSize: "14px",
  lineHeight: "1.45",
};

const styles = {
  user: { ...bubbleBase, background: "#1f2937", color: "#ffffff", alignSelf: "flex-end" },
  assistant: { ...bubbleBase, background: "#f1f1f1", color: "#1a1a1a", alignSelf: "flex-start" },
  tool: { alignSelf: "center", color: "#6b7280", fontSize: "12px", fontStyle: "italic" },
};

export default function ConversationDetail() {
  const { conversationId, items } = useLoaderData();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const transcript = items
      .map((item) =>
        item.kind === "tool"
          ? `[${item.text}]`
          : `${item.kind === "user" ? "Customer" : "Assistant"}: ${item.text}`
      )
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Clipboard copy failed:", e);
    }
  };

  return (
    <s-page>
      <ui-title-bar title="Conversation transcript" />

      <s-section>
        <s-stack gap="base">
          <s-paragraph>
            <Link to="/app/conversations">← Back to conversations</Link>
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-text tone="subdued">ID: {conversationId}</s-text>
            <button
              onClick={handleCopy}
              style={{ padding: "4px 12px", borderRadius: "6px", border: "1px solid #8a8a8a", background: "#ffffff", cursor: "pointer", fontSize: "12px" }}
            >
              {copied ? "Copied!" : "Copy transcript"}
            </button>
          </s-stack>

          {items.length === 0 ? (
            <s-paragraph>No messages found for this conversation.</s-paragraph>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "8px" }}>
              {items.map((item, i) => (
                <div key={i} style={styles[item.kind] || styles.assistant}>
                  {item.text}
                </div>
              ))}
            </div>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
