import { requireOpenAIAuth } from "./auth.js";

const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

export function requireOpenAIConfig() {
  return requireOpenAIAuth();
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

async function deleteOpenAIProjectUser(id) {
  const { projectId } = requireOpenAIConfig();
  await openAIRequest(`/organization/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function revokeOpenAISessionKey(id) {
  const { projectId } = requireOpenAIConfig();
  try {
    await openAIRequest(
      `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  } catch (error) {
    // OpenAI lists project service accounts as user-* objects on some orgs.
    // If the service-account endpoint rejects that id, remove the project user.
    if (String(error?.message || error).includes("No service account found") || String(error?.message || error).includes("404")) {
      await deleteOpenAIProjectUser(id);
      return;
    }
    throw error;
  }
}

export async function revokeOpenAIProjectApiKeysByServiceAccountName(name) {
  const keys = await listOpenAIProjectApiKeys();
  const matches = keys.filter((item) => item.ownerName === name || item.name === name);
  let revoked = 0;
  let lastError;
  for (const match of matches) {
    try {
      await revokeOpenAIProjectApiKey(match.id);
      revoked++;
    } catch (error) {
      if (String(error?.message || error).includes("owned by a service account") && match.ownerId) {
        await revokeOpenAISessionKey(match.ownerId);
        revoked++;
      } else {
        lastError = error;
      }
    }
  }
  if (revoked === 0 && lastError) throw lastError;
  return revoked;
}

export async function revokeOpenAISessionKeyByName(name) {
  // For service-account-owned keys, OpenAI rejects direct API-key deletion and
  // requires deleting/removing the service account/project user. Do that first.
  const serviceAccounts = await listOpenAISessionKeys();
  const matches = serviceAccounts.filter((item) => item.name === name);
  let revokedServiceAccounts = 0;
  let lastError;

  for (const match of matches) {
    const candidates = match.idCandidates?.length ? match.idCandidates : [match.id];
    for (const id of candidates) {
      try {
        await revokeOpenAISessionKey(id);
        revokedServiceAccounts++;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (revokedServiceAccounts > 0) return revokedServiceAccounts;

  // Fallback for non-service-account project API keys with eph names.
  const revokedApiKeys = await revokeOpenAIProjectApiKeysByServiceAccountName(name);
  if (revokedApiKeys > 0) return revokedApiKeys;
  if (lastError) throw lastError;
  return 0;
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
