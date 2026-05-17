const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

export function requireOpenAIConfig() {
  const adminKey = process.env.OPENAI_ADMIN_KEY;
  const projectId = process.env.OPENAI_PROJECT_ID;
  if (!adminKey) {
    throw new Error("OPENAI_ADMIN_KEY is required for managed OpenAI credentials.");
  }
  if (!projectId) {
    throw new Error("OPENAI_PROJECT_ID is required for managed OpenAI credentials.");
  }
  return { adminKey, projectId };
}

async function openAIRequest(path, options = {}) {
  const { adminKey } = requireOpenAIConfig();
  const response = await fetch(`${OPENAI_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${adminKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const message = body?.error?.message || body?.message || text || response.statusText;
    throw new Error(`OpenAI Admin API ${response.status} ${response.statusText}: ${message}`);
  }
  return body;
}

function getServiceAccountApiKey(body) {
  if (typeof body.api_key === "string") return body.api_key;
  if (typeof body.key === "string") return body.key;
  if (typeof body.value === "string" && body.value.startsWith("sk-")) return body.value;
  if (typeof body.api_key?.value === "string") return body.api_key.value;
  if (typeof body.apiKey?.value === "string") return body.apiKey.value;
  if (typeof body.secret === "string") return body.secret;
  return undefined;
}

function getServiceAccountApiKeyId(body) {
  return body.api_key?.id || body.apiKey?.id || body.key?.id || body.api_key_id || body.apiKeyId;
}

function serviceAccountIdCandidates(item) {
  return [
    item.service_account_id,
    item.serviceAccountId,
    item.service_account?.id,
    item.serviceAccount?.id,
    item.id,
  ].filter((value, index, array) => typeof value === "string" && value && array.indexOf(value) === index);
}

function serviceAccountPrimaryId(item) {
  return serviceAccountIdCandidates(item)[0];
}

export async function createOpenAISessionKey({ name }) {
  const { projectId } = requireOpenAIConfig();
  const body = await openAIRequest(`/organization/projects/${encodeURIComponent(projectId)}/service_accounts`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  const apiKey = getServiceAccountApiKey(body);
  let id = serviceAccountPrimaryId(body);

  // Some OpenAI responses include a user-* id on create, while the DELETE endpoint
  // expects the service-account id returned by list. Prefer the listed id when we
  // can find the newly-created service account by exact name.
  try {
    const listed = await listOpenAISessionKeys();
    const match = listed.find((item) => item.name === name);
    if (match?.id) id = match.id;
  } catch {
    // If list is unavailable, fall back to ids present in the create response.
  }

  id ||= body.id;

  if (!id) {
    throw new Error(`OpenAI response did not include a service account id. Response keys: ${Object.keys(body).join(", ")}`);
  }
  if (!apiKey) {
    throw new Error(
      "OpenAI response did not include a readable API key. The service account may have been created; run `eph keys list` and revoke it if needed."
    );
  }

  return {
    id,
    apiKeyId: getServiceAccountApiKeyId(body),
    name: body.name || name,
    apiKey,
    raw: body,
  };
}

export async function listOpenAISessionKeys() {
  const { projectId } = requireOpenAIConfig();
  const body = await openAIRequest(`/organization/projects/${encodeURIComponent(projectId)}/service_accounts`, {
    method: "GET",
  });
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  return data.map((item) => ({
    id: serviceAccountPrimaryId(item),
    idCandidates: serviceAccountIdCandidates(item),
    name: item.name || "",
    createdAt: item.created_at || item.createdAt,
    raw: item,
  }));
}

export async function listOpenAIProjectApiKeys() {
  const { projectId } = requireOpenAIConfig();
  const body = await openAIRequest(`/organization/projects/${encodeURIComponent(projectId)}/api_keys`, {
    method: "GET",
  });
  const data = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  return data.map((item) => ({
    id: item.id,
    name: item.name || "",
    createdAt: item.created_at || item.createdAt,
    ownerName:
      item.owner?.service_account?.name ||
      item.owner?.serviceAccount?.name ||
      item.service_account?.name ||
      item.serviceAccount?.name ||
      "",
    ownerId:
      item.owner?.service_account?.id ||
      item.owner?.serviceAccount?.id ||
      item.service_account?.id ||
      item.serviceAccount?.id ||
      "",
    raw: item,
  }));
}

export async function revokeOpenAIProjectApiKey(id) {
  const { projectId } = requireOpenAIConfig();
  await openAIRequest(`/organization/projects/${encodeURIComponent(projectId)}/api_keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function revokeOpenAISessionKey(id) {
  const { projectId } = requireOpenAIConfig();
  await openAIRequest(
    `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

export async function revokeOpenAIProjectApiKeysByServiceAccountName(name) {
  const keys = await listOpenAIProjectApiKeys();
  const matches = keys.filter((item) => item.ownerName === name || item.name === name);
  for (const match of matches) {
    await revokeOpenAIProjectApiKey(match.id);
  }
  return matches.length;
}

export async function revokeOpenAISessionKeyByName(name) {
  // The sensitive credential is the project API key, not the service-account shell.
  // OpenAI currently lists service accounts as user-* ids, while the service-account
  // DELETE endpoint may reject those ids. Revoke matching project API keys first.
  const revokedApiKeys = await revokeOpenAIProjectApiKeysByServiceAccountName(name);

  const keys = await listOpenAISessionKeys();
  const matches = keys.filter((item) => item.name === name);
  let revokedServiceAccounts = 0;
  for (const match of matches) {
    const candidates = match.idCandidates?.length ? match.idCandidates : [match.id];
    for (const id of candidates) {
      try {
        await revokeOpenAISessionKey(id);
        revokedServiceAccounts++;
        break;
      } catch {
        // Service-account deletion is best effort. Revoking the project API key is
        // what removes credential access.
      }
    }
  }
  return revokedApiKeys + revokedServiceAccounts;
}

export function redactOpenAIObject(value) {
  if (Array.isArray(value)) return value.map(redactOpenAIObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const lower = key.toLowerCase();
      if (lower.includes("secret") || lower === "value" || lower === "api_key" || lower === "apikey") {
        return [key, typeof entry === "string" ? "[redacted]" : redactOpenAIObject({ ...entry, value: "[redacted]" })];
      }
      return [key, redactOpenAIObject(entry)];
    })
  );
}

export function ephKeyName(label = "session", ttlSeconds = 7200) {
  const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
  const now = new Date();
  const exp = new Date(now.getTime() + ttlSeconds * 1000);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const expStamp = exp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8);
  return `eph-${safeLabel}-${stamp}-exp-${expStamp}-${rand}`;
}

export function parseExpiryFromName(name) {
  const match = /-exp-(\d{8}T\d{6}Z)-/.exec(name || "");
  if (!match) return undefined;
  const s = match[1];
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
}
