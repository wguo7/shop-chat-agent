/**
 * Admin: Knowledge base manager — upload and remove product manuals without
 * touching GitHub. Files are committed to the repo via the GitHub API, which
 * triggers the rebuild-index workflow (re-embed + deploy, ~3-5 minutes).
 * Behind Shopify admin auth. Needs GITHUB_TOKEN in env (fine-grained PAT with
 * Contents read/write on the repo).
 */
import { useState } from "react";
import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { authenticate } from "../shopify.server";
import AppConfig from "../services/config.server";

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

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  if (!process.env.GITHUB_TOKEN) {
    return { configured: false, files: [] };
  }

  const res = await fetch(ghUrl(""), { headers: ghHeaders() });
  if (!res.ok) {
    return { configured: true, error: `GitHub API error ${res.status}`, files: [] };
  }
  const entries = await res.json();
  const files = entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md") && !["_TEMPLATE.md", "STYLE.md"].includes(e.name))
    .map((e) => ({ name: e.name, sha: e.sha, size: e.size, protected: PROTECTED_FILES.has(e.name) }));

  return { configured: true, files };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  if (!process.env.GITHUB_TOKEN) return { ok: false, message: "GITHUB_TOKEN is not configured." };

  const form = await request.formData();
  const intent = form.get("intent");
  const { githubBranch } = AppConfig.admin;

  try {
    if (intent === "delete") {
      const name = String(form.get("name") || "");
      const sha = String(form.get("sha") || "");
      if (!name.endsWith(".md") || PROTECTED_FILES.has(name) || name.includes("/") || name.includes("..")) {
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
      return { ok: true, message: `${name} removed. The bot updates automatically in ~5 minutes.` };
    }

    if (intent === "upload") {
      const sku = String(form.get("sku") || "").trim().toUpperCase();
      const productName = String(form.get("product_name") || "").trim();
      const keywords = String(form.get("keywords") || "").trim();
      const content = String(form.get("content") || "").trim();

      if (!/^[A-Z0-9][A-Z0-9-]{1,30}$/.test(sku)) return { ok: false, message: "Enter a valid SKU (e.g. NT-1234)." };
      if (!content) return { ok: false, message: "Manual text is required." };

      // If they pasted a complete knowledge file (starts with frontmatter), take
      // it as-is; otherwise compose a minimal valid file around the manual text.
      let fileBody;
      if (content.startsWith("---")) {
        fileBody = content;
      } else {
        if (!productName) return { ok: false, message: "Product name is required." };
        const keywordLines = keywords
          ? keywords.split(",").map((k) => `  - ${k.trim()}`).filter((k) => k.trim() !== "-").join("\n")
          : `  - ${sku}`;
        fileBody = [
          "---",
          `sku: ${sku}`,
          `product_name: "${productName.replace(/"/g, "'")}"`,
          "keywords:",
          keywordLines,
          "---",
          `# ${productName} (${sku})`,
          "",
          "## Manual",
          content,
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
      return { ok: true, message: `${name} ${sha ? "updated" : "added"}. The bot updates automatically in ~5 minutes (Actions tab on GitHub shows progress).` };
    }

    return { ok: false, message: "Unknown action." };
  } catch (e) {
    console.error("Knowledge admin action failed:", e);
    return { ok: false, message: `Something went wrong: ${e.message}` };
  }
};

const cellStyle = { padding: "8px 12px", borderBottom: "1px solid #e3e3e3", textAlign: "left" };
const inputStyle = { padding: "8px", border: "1px solid #8a8a8a", borderRadius: "6px", fontSize: "13px", width: "100%", boxSizing: "border-box" };
const buttonStyle = { padding: "8px 16px", borderRadius: "8px", border: "1px solid #8a8a8a", background: "#ffffff", cursor: "pointer", fontSize: "13px" };

export default function Knowledge() {
  const { configured, error, files } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const [manualText, setManualText] = useState("");

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

      <s-section heading="Add or update a manual">
        <Form method="post">
          <input type="hidden" name="intent" value="upload" />
          <div style={{ display: "grid", gap: "16px", maxWidth: "640px" }}>

            <div style={{ display: "grid", gap: "4px" }}>
              <s-text fontWeight="bold">Step 1 — Model number (SKU)</s-text>
              <s-text tone="subdued">
                Exactly as printed on the product and manual, e.g. NT-8810.
                Using a SKU that already exists below REPLACES that product's manual.
              </s-text>
              <input name="sku" placeholder="NT-8810" style={inputStyle} required />
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <s-text fontWeight="bold">Step 2 — Product name</s-text>
              <s-text tone="subdued">
                The name customers see on the store, without the SKU.
              </s-text>
              <input name="product_name" placeholder="Rechargeable Magnetic Light Bar" style={inputStyle} />
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <s-text fontWeight="bold">Step 3 — Customer phrases (optional, recommended)</s-text>
              <s-text tone="subdued">
                What a customer might call this product instead of the SKU, separated
                by commas. These help the bot match questions like "the magnetic bar light".
              </s-text>
              <input name="keywords" placeholder="magnetic light bar, underhood light bar, hood light" style={inputStyle} />
            </div>

            <div style={{ display: "grid", gap: "4px" }}>
              <s-text fontWeight="bold">Step 4 — Manual text</s-text>
              <s-text tone="subdued">
                PDFs cannot be uploaded directly. Open the PDF manual, select all the
                text, copy, and paste it below. The important parts are: specifications,
                operating instructions, charging, troubleshooting, and warranty —
                legal boilerplate can be skipped. AFTER PASTING, SKIM IT: if lines jump
                between unrelated topics (common with two-column manuals), rearrange the
                sections so each reads top to bottom. Alternatively, choose a .md or
                .txt file and it will fill the box for you.
              </s-text>
              <div>
                <input type="file" accept=".md,.txt" onChange={handleFile} />
              </div>
              <textarea
                name="content"
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={
                  "Example of what to paste:\n\n" +
                  "The NT-8810 is a rechargeable LED light bar with magnetic ends.\n\n" +
                  "SPECIFICATIONS\n" +
                  "Brightness: 1200 lumens (high), 600 lumens (low)\n" +
                  "Battery: 3.7V 4000 mAh lithium-ion\n" +
                  "Charging time: 4 hours via USB-C (cable included)\n" +
                  "Runtime: 3 hrs (high), 6 hrs (low)\n\n" +
                  "OPERATION\n" +
                  "1. Press the power button once for high mode.\n" +
                  "2. Press again for low mode.\n" +
                  "3. Press a third time to turn off.\n\n" +
                  "CHARGING\n" +
                  "Connect the included USB-C cable to the port under the rubber cap.\n" +
                  "The indicator is red while charging and green when full."
                }
                rows={16}
                style={{ ...inputStyle, fontFamily: "monospace" }}
                required
              />
            </div>

            <div>
              <button type="submit" disabled={busy} style={buttonStyle}>
                {busy ? "Saving..." : "Save manual"}
              </button>
            </div>
            <s-text tone="subdued">
              After saving, the bot learns this automatically in about 5 minutes — then
              test it by asking the chat on the storefront a question about this product.
              For richer structure (spec tables, pre-written Q&A), see knowledge/STYLE.md
              in the GitHub repo.
            </s-text>
          </div>
        </Form>
      </s-section>

      <s-section heading={`Current manuals (${files.length})`}>
        {error && <s-text tone="critical">{error}</s-text>}
        <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: "640px" }}>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td style={cellStyle}><s-text>{f.name}</s-text></td>
                <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                  {f.protected ? (
                    <s-text tone="subdued">core file — cannot be removed</s-text>
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
                      <button type="submit" disabled={busy} style={{ ...buttonStyle, color: "#b91c1c" }}>
                        Remove
                      </button>
                    </Form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>
    </s-page>
  );
}
