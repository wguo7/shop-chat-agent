/**
 * Admin: Knowledge base manager: upload, edit, and remove the bot's product
 * manuals and store-wide answers without touching GitHub. Files are committed
 * to the repo via the GitHub API, which triggers the rebuild-index workflow
 * (re-embed + deploy, ~5 minutes). Behind Shopify admin auth. Needs
 * GITHUB_TOKEN in env (fine-grained PAT with Contents read/write on the repo).
 */
import { useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form, Link } from "react-router";
import { authenticate } from "../shopify.server";
import AppConfig from "../services/config.server";

// Structured-manual skeleton the "Template" button drops into the text box.
// Sections become individually searchable chunks; the Common questions entries
// are the highest-value part (each Q&A is its own chunk).
const STRUCTURED_TEMPLATE = `## What it is
One short paragraph: what the product is, what jobs it is for, and what makes it different.

## Specifications
| Spec | Value |
| --- | --- |
| Brightness high | XXXX lm |
| Brightness low | XXX lm |
| Battery | X.XV XXXX mAh lithium-ion |
| Charging time | X hrs |
| Runtime | X hrs high, X hrs low |

## Common questions
**How long does the battery last on the NT-XXXX?**
Answer in one or two sentences.

**How do I charge the NT-XXXX and how long does it take?**
Answer.

**What comes in the box with the NT-XXXX?**
Answer.

**What is the NT-XXXX best used for?**
Answer.

## Warranty
1 year limited warranty.

## Full manual text (verbatim)
Paste the full manual text here, in reading order: specifications, operation, charging, troubleshooting, warranty.
`;

const GH_API = "https://api.github.com";
// Files that must not be deleted from the admin UI: internal docs plus the
// company-wide knowledge files (policies, catalog comparison) that the bot
// depends on for non-product questions.
const PROTECTED_FILES = new Set(["_TEMPLATE.md", "STYLE.md", "company-and-policies.md", "product-index.md"]);

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function ghUrl(path) {
  const { githubRepo, githubBranch } = AppConfig.admin;
  return `${GH_API}/repos/${githubRepo}/contents/knowledge/${path}?ref=${githubBranch}`;
}

function isSafeName(name) {
  return Boolean(name) && name.endsWith(".md") && !name.includes("/") && !name.includes("..");
}

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  if (!process.env.GITHUB_TOKEN) {
    return { configured: false, files: [], editing: null };
  }

  // ?edit=<file>.md opens that file's content in the editor section.
  const url = new URL(request.url);
  const editName = url.searchParams.get("edit");
  const safeEdit = isSafeName(editName) ? editName : null;

  const [listRes, editRes] = await Promise.all([
    fetch(ghUrl(""), { headers: ghHeaders() }),
    safeEdit ? fetch(ghUrl(safeEdit), { headers: ghHeaders() }) : Promise.resolve(null),
  ]);
  if (!listRes.ok) {
    return { configured: true, error: `GitHub API error ${listRes.status}`, files: [], editing: null };
  }
  const entries = await listRes.json();
  const files = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md") && !["_TEMPLATE.md", "STYLE.md"].includes(e.name))
    .map((e) => ({ name: e.name, sha: e.sha, size: e.size, protected: PROTECTED_FILES.has(e.name) }));

  let editing = null;
  if (editRes && editRes.ok) {
    const j = await editRes.json();
    editing = { name: safeEdit, sha: j.sha, content: Buffer.from(j.content, "base64").toString("utf8") };
  }

  return { configured: true, files, editing };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  if (!process.env.GITHUB_TOKEN) return { ok: false, message: "GITHUB_TOKEN is not configured." };

  const form = await request.formData();
  const intent = form.get("intent");
  const { githubBranch } = AppConfig.admin;

  try {
    if (intent === "save-file") {
      const name = String(form.get("name") || "");
      const sha = String(form.get("sha") || "");
      const content = String(form.get("content") || "");
      if (!isSafeName(name)) return { ok: false, message: "Invalid file." };
      if (!content.startsWith("---") || content.trim().length < 100) {
        return { ok: false, message: "Not saved: the file must keep its --- header and its content. Cancel and re-open to start over." };
      }
      const res = await fetch(ghUrl(name).split("?")[0], {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify({
          message: `kb: edit ${name} via admin`,
          content: Buffer.from(content, "utf8").toString("base64"),
          branch: githubBranch,
          sha,
        }),
      });
      if (!res.ok) return { ok: false, message: `Save failed: ${res.status} ${await res.text()}` };
      return { ok: true, message: `${name} saved. Live in about 5 minutes.` };
    }

    if (intent === "delete") {
      const name = String(form.get("name") || "");
      const sha = String(form.get("sha") || "");
      if (!isSafeName(name) || PROTECTED_FILES.has(name)) {
        return { ok: false, message: "Invalid file." };
      }
      const res = await fetch(ghUrl(name).split("?")[0], {
        method: "DELETE",
        headers: ghHeaders(),
        body: JSON.stringify({
          message: `kb: remove ${name} via admin`,
          sha,
          branch: githubBranch,
        }),
      });
      if (!res.ok) return { ok: false, message: `Delete failed: ${res.status} ${await res.text()}` };
      return { ok: true, message: `${name} removed. Live in about 5 minutes.` };
    }

    if (intent === "upload") {
      const sku = String(form.get("sku") || "").trim().toUpperCase();
      const productName = String(form.get("product_name") || "").trim();
      const keywords = String(form.get("keywords") || "").trim();
      const content = String(form.get("content") || "").trim();

      if (!/^[A-Z0-9][A-Z0-9-]{1,30}$/.test(sku)) return { ok: false, message: "Enter a valid SKU (e.g. NT-1234)." };
      if (!content) return { ok: false, message: "Manual text is required." };

      // If they pasted a complete knowledge file (starts with frontmatter), take
      // it as-is; otherwise compose a valid file around the pasted text.
      let fileBody;
      if (content.startsWith("---")) {
        fileBody = content;
      } else {
        if (!productName) return { ok: false, message: "Product name is required." };
        const keywordLines = keywords
          ? keywords.split(",").map((k) => `  - ${k.trim()}`).filter((k) => k.trim() !== "-").join("\n")
          : `  - ${sku}`;
        // Pasted text with its own "## Section" headings (e.g. the template)
        // keeps them; plain text becomes one Manual section.
        const body = /^##\s/m.test(content) ? content : `## Manual\n${content}`;
        fileBody = [
          "---",
          `sku: ${sku}`,
          `product_name: "${productName.replace(/"/g, "'")}"`,
          "keywords:",
          keywordLines,
          "---",
          `# ${productName} (${sku})`,
          "",
          body,
          "",
        ].join("\n");
      }

      const name = `${sku}.md`;
      // Updating an existing file requires its current sha.
      const existing = await fetch(ghUrl(name), { headers: ghHeaders() });
      const sha = existing.ok ? (await existing.json()).sha : undefined;

      const res = await fetch(ghUrl(name).split("?")[0], {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify({
          message: `kb: ${sha ? "update" : "add"} ${name} via admin`,
          content: Buffer.from(fileBody, "utf8").toString("base64"),
          branch: githubBranch,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!res.ok) return { ok: false, message: `Upload failed: ${res.status} ${await res.text()}` };
      return { ok: true, message: `${name} ${sha ? "updated" : "added"}. Live in about 5 minutes (Actions tab on GitHub shows progress).` };
    }

    return { ok: false, message: "Unknown action." };
  } catch (e) {
    console.error("Knowledge admin action failed:", e);
    return { ok: false, message: `Something went wrong: ${e.message}` };
  }
};

const cellStyle = { padding: "5px 10px", borderBottom: "1px solid #ececec", textAlign: "left" };
const inputStyle = { padding: "7px 9px", border: "1px solid #8a8a8a", borderRadius: "6px", fontSize: "13px", width: "100%", boxSizing: "border-box" };
const buttonStyle = { padding: "7px 14px", borderRadius: "7px", border: "1px solid #8a8a8a", background: "#ffffff", cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap" };
const labelStyle = { fontSize: "12px", fontWeight: 600, color: "#444" };

export default function Knowledge() {
  const { configured, error, files, editing } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [manualText, setManualText] = useState("");

  const loadTemplate = () => {
    if (manualText.trim() && !confirm("Replace the text box contents with the structured template?")) return;
    setManualText(STRUCTURED_TEMPLATE);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setManualText(String(reader.result || ""));
    reader.readAsText(file);
  };

  if (!configured) {
    return (
      <s-page>
        <ui-title-bar title="Knowledge base" />
        <s-section heading="Setup needed">
          <s-paragraph>
            Add a <s-text fontWeight="bold">GITHUB_TOKEN</s-text> environment variable in Vercel
            (fine-grained personal access token with Contents read/write on the repo), then redeploy.
            See MAINTAINING.md.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page>
      <ui-title-bar title="Knowledge base" />

      {actionData && (
        <s-section>
          <s-text tone={actionData.ok ? "success" : "critical"}>{actionData.message}</s-text>
        </s-section>
      )}

      {editing && (
        <s-section heading={`Editing ${editing.name}`}>
          <Form method="post">
            <input type="hidden" name="intent" value="save-file" />
            <input type="hidden" name="name" value={editing.name} />
            <input type="hidden" name="sha" value={editing.sha} />
            <div style={{ display: "grid", gap: "8px" }}>
              <s-text tone="subdued">
                Keep the --- header (controls matching). Each ## section is searched
                separately; Common questions entries answer best.
              </s-text>
              <textarea name="content" defaultValue={editing.content} rows={24} style={{ ...inputStyle, fontFamily: "monospace" }} required />
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <button type="submit" disabled={busy} style={buttonStyle}>{busy ? "Saving..." : "Save changes"}</button>
                <Link to="/app/knowledge">Cancel</Link>
              </div>
            </div>
          </Form>
        </s-section>
      )}

      <s-section heading="Add or update a manual">
        <Form method="post">
          <input type="hidden" name="intent" value="upload" />
          <div style={{ display: "grid", gap: "10px", maxWidth: "640px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "10px" }}>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={labelStyle}>SKU</span>
                <input name="sku" placeholder="NT-8810" style={inputStyle} required />
              </div>
              <div style={{ display: "grid", gap: "3px" }}>
                <span style={labelStyle}>Product name</span>
                <input name="product_name" placeholder="Rechargeable Magnetic Light Bar" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={labelStyle}>Customer phrases (optional)</span>
              <input name="keywords" placeholder="magnetic light bar, underhood light bar, hood light" style={inputStyle} />
            </div>
            <div style={{ display: "grid", gap: "3px" }}>
              <span style={labelStyle}>Manual text</span>
              <textarea
                name="content"
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={"Paste the manual text (copy it out of the PDF; PDFs can't be uploaded directly). Specs, operation, charging, troubleshooting, warranty are the parts that matter."}
                rows={12}
                style={{ ...inputStyle, fontFamily: "monospace" }}
                required
              />
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}>
              <button type="submit" disabled={busy} style={{ ...buttonStyle, fontWeight: 600 }}>
                {busy ? "Saving..." : "Save manual"}
              </button>
              <button type="button" onClick={loadTemplate} style={buttonStyle}>Template</button>
              <input type="file" accept=".md,.txt" onChange={handleFile} style={{ fontSize: "12px" }} />
            </div>
            <details>
              <summary style={{ fontSize: "12px", color: "#666", cursor: "pointer" }}>Tips</summary>
              <div style={{ fontSize: "12px", color: "#555", lineHeight: 1.5, paddingTop: "6px" }}>
                Re-using a SKU replaces that manual. Customer phrases are what shoppers say instead
                of the SKU. Check that pasted PDF text reads in order. Template inserts the
                recommended structure. Saves go live in about 5 minutes; test on the storefront chat.
              </div>
            </details>
          </div>
        </Form>
      </s-section>

      <s-section heading={`Files (${files.length})`}>
        {error && <s-text tone="critical">{error}</s-text>}
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: "640px", fontSize: "13px" }}>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td style={cellStyle}><s-text>{f.name}</s-text></td>
                <td style={{ ...cellStyle, whiteSpace: "nowrap", width: "1%" }}>
                  <Link to={`/app/knowledge?edit=${encodeURIComponent(f.name)}`}>Edit</Link>
                </td>
                <td style={{ ...cellStyle, whiteSpace: "nowrap", width: "1%" }}>
                  {f.protected ? (
                    <span style={{ fontSize: "12px", color: "#999" }}>core</span>
                  ) : (
                    <Form
                      method="post"
                      onSubmit={(e) => {
                        if (!confirm(`Remove ${f.name}? The bot will stop knowing about this product.`)) e.preventDefault();
                      }}
                    >
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="name" value={f.name} />
                      <input type="hidden" name="sha" value={f.sha} />
                      <button type="submit" disabled={busy} style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: "13px", padding: 0 }}>
                        Remove
                      </button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <s-paragraph>
          <s-text tone="subdued">
            Store-wide answers and redirect links: edit company-and-policies.md. Bot tone and hard
            rules: app/prompts/prompts.json in the repo (redirect URLs live in both, change both).
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
