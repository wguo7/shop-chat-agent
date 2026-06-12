/**
 * Admin: Settings — rotate API keys and the domain allowlist without the
 * Vercel dashboard. Updates the env var via the Vercel API and triggers a
 * production redeploy so it takes effect. Write-only: existing values are
 * never displayed. Behind Shopify admin auth. Needs VERCEL_TOKEN in env.
 */
import { useLoaderData, useActionData, useNavigation, Form } from "react-router";
import { authenticate } from "../shopify.server";
import AppConfig from "../services/config.server";

const VERCEL_API = "https://api.vercel.com";

function vcHeaders() {
  return {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function vcUrl(path) {
  const { vercelTeamId } = AppConfig.admin;
  return `${VERCEL_API}${path}${path.includes("?") ? "&" : "?"}teamId=${vercelTeamId}`;
}

const KEY_DESCRIPTIONS = {
  CLAUDE_API_KEY: "Anthropic API key the chat answers with (console.anthropic.com)",
  VOYAGE_API_KEY: "Voyage AI key for manual search embeddings (dash.voyageai.com). If you change it, also update the VOYAGE_API_KEY secret on GitHub (repo Settings > Secrets > Actions) so manual uploads keep working.",
  ALLOWED_ORIGINS: "Store domains allowed to use the chat, comma-separated (e.g. https://nextool.myshopify.com,https://mynextled.com)",
};

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {
    configured: Boolean(process.env.VERCEL_TOKEN),
    keys: AppConfig.admin.editableEnvKeys.map((k) => ({ key: k, description: KEY_DESCRIPTIONS[k] || "" })),
  };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  if (!process.env.VERCEL_TOKEN) return { ok: false, message: "VERCEL_TOKEN is not configured." };

  const form = await request.formData();
  const key = String(form.get("key") || "");
  const value = String(form.get("value") || "").trim();
  const { vercelProjectId, editableEnvKeys } = AppConfig.admin;

  // Hard whitelist: this page must never be able to touch DATABASE_URL etc.
  if (!editableEnvKeys.includes(key)) return { ok: false, message: "That setting cannot be changed here." };
  if (!value) return { ok: false, message: "Enter a value." };

  try {
    // Find the env var's id (names/ids only; values are not readable for
    // sensitive vars, which is fine — this page is write-only).
    const listRes = await fetch(vcUrl(`/v9/projects/${vercelProjectId}/env`), { headers: vcHeaders() });
    if (!listRes.ok) return { ok: false, message: `Vercel API error ${listRes.status}` };
    const { envs } = await listRes.json();
    const target = envs.find((e) => e.key === key && e.target?.includes("production"));
    if (!target) return { ok: false, message: `${key} not found in Vercel project env.` };

    const patchRes = await fetch(vcUrl(`/v9/projects/${vercelProjectId}/env/${target.id}`), {
      method: "PATCH",
      headers: vcHeaders(),
      body: JSON.stringify({ value }),
    });
    if (!patchRes.ok) return { ok: false, message: `Update failed: ${patchRes.status} ${await patchRes.text()}` };

    // Redeploy the latest production deployment so the new value takes effect.
    const depRes = await fetch(
      vcUrl(`/v6/deployments?projectId=${vercelProjectId}&target=production&limit=1&state=READY`),
      { headers: vcHeaders() }
    );
    const latest = depRes.ok ? (await depRes.json()).deployments?.[0] : null;
    if (latest) {
      const redeploy = await fetch(vcUrl(`/v13/deployments?forceNew=1`), {
        method: "POST",
        headers: vcHeaders(),
        body: JSON.stringify({
          name: "shop-chat-agent",
          deploymentId: latest.uid,
          target: "production",
          meta: { action: "redeploy" },
        }),
      });
      if (!redeploy.ok) {
        return {
          ok: true,
          message: `${key} saved, but auto-redeploy failed — click "Redeploy" on the latest deployment in the Vercel dashboard to apply it.`,
        };
      }
    }

    return { ok: true, message: `${key} updated. A redeploy is running; the change is live in ~1-2 minutes.` };
  } catch (e) {
    console.error("Settings update failed:", e);
    return { ok: false, message: `Something went wrong: ${e.message}` };
  }
};

const inputStyle = { padding: "8px", border: "1px solid #8a8a8a", borderRadius: "6px", fontSize: "13px", width: "100%", boxSizing: "border-box", fontFamily: "monospace" };
const buttonStyle = { padding: "8px 16px", borderRadius: "8px", border: "1px solid #8a8a8a", background: "#ffffff", cursor: "pointer", fontSize: "13px", whiteSpace: "nowrap" };

export default function Settings() {
  const { configured, keys } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  if (!configured) {
    return (
      <s-page>
        <ui-title-bar title="Settings" />
        <s-section heading="Setup needed">
          <s-paragraph>
            Add a <s-text fontWeight="bold">VERCEL_TOKEN</s-text> environment variable in Vercel
            (create at vercel.com/account/tokens), then redeploy. See MAINTAINING.md.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page>
      <ui-title-bar title="Settings" />

      {actionData && (
        <s-section>
          <s-text tone={actionData.ok ? "success" : "critical"}>{actionData.message}</s-text>
        </s-section>
      )}

      <s-section heading="API keys & domains">
        <s-paragraph>
          <s-text tone="subdued">
            Values are write-only: paste a new value and save. Current values are never shown.
            Each save redeploys the app (~1-2 minutes).
          </s-text>
        </s-paragraph>
        <div style={{ display: "grid", gap: "18px", maxWidth: "640px", marginTop: "12px" }}>
          {keys.map(({ key, description }) => (
            <Form key={key} method="post">
              <input type="hidden" name="key" value={key} />
              <div style={{ display: "grid", gap: "6px" }}>
                <s-text fontWeight="bold">{key}</s-text>
                <s-text tone="subdued">{description}</s-text>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    name="value"
                    type={key.includes("KEY") ? "password" : "text"}
                    placeholder="New value"
                    style={inputStyle}
                    autoComplete="off"
                  />
                  <button type="submit" disabled={busy} style={buttonStyle}>
                    {busy ? "Saving..." : "Save"}
                  </button>
                </div>
              </div>
            </Form>
          ))}
        </div>
      </s-section>
    </s-page>
  );
}
