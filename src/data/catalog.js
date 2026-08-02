// The provider catalog, fetched from the Worker so the model list and the
// capability flags have exactly one home (worker/providers.js). The response
// says which providers have a key configured — never what the key is.

let catalog = [];

export async function loadCatalog() {
  const res = await fetch("/api/providers");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not load providers (${res.status})`);
  }
  const data = await res.json();
  catalog = data.providers;
  return data;
}

export function providers() {
  return catalog;
}

export function getProvider(id) {
  return catalog.find((p) => p.id === id) || null;
}

// A provider with no key can't be used, so the first configured one is the
// sensible default; fall back to the first overall so the UI still renders
// (and can explain what's missing).
export function defaultProvider() {
  return catalog.find((p) => p.configured) || catalog[0] || null;
}

// Mirrors modelCaps() on the server: a hand-typed model still works, it just
// inherits the provider's defaults.
export function capsFor(providerId, modelId) {
  const provider = getProvider(providerId);
  if (!provider) return { temperature: true, thinking: false };
  const known = provider.models.find((m) => m.id === modelId);
  return known ? { temperature: known.temperature, thinking: known.thinking } : provider.defaultCaps;
}
