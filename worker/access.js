// Cloudflare Access identity.
//
// Behind Access every request carries a signed JWT in Cf-Access-Jwt-Assertion.
// Verify it against the team's public keys and the app's AUD before trusting
// the email claim, so a request that somehow reaches the Worker without going
// through Access can't spoof an identity.

let cachedCerts = null;

async function getAccessCerts(teamDomain, force = false) {
  if (cachedCerts && !force) return cachedCerts;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("Failed to fetch Access certs");
  cachedCerts = (await res.json()).keys;
  return cachedCerts;
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function verifyAccessJwt(token, teamDomain, aud) {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("Malformed JWT");
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));

  let keys = await getAccessCerts(teamDomain);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key may have rotated since we cached; refetch once.
    keys = await getAccessCerts(teamDomain, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("Signing key not found");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sigB64), signed);
  if (!ok) throw new Error("Bad signature");

  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));
  if (payload.exp && Date.now() / 1000 > payload.exp) throw new Error("Token expired");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error("AUD mismatch");
  return payload;
}

// Returns { email } on success, or { error, status } describing why not.
//
// Without Access in front there is no identity to verify, so `wrangler dev`
// needs a stub one. That stub is gated on LOCAL_DEV rather than on the request
// hostname: `wrangler dev` reports the configured custom-domain hostname as
// request.url, so the host says nothing about where the Worker is running.
// LOCAL_DEV lives only in .dev.vars, which is untracked and never deployed.
//
// A deployed Worker with no AUD is an unauthenticated proxy in front of paid
// API keys, so it fails closed instead of serving anyone who finds the URL.
export async function authenticate(request, env) {
  if (!env.CF_ACCESS_AUD) {
    if (env.LOCAL_DEV === "1") return { email: "local@dev" };
    return {
      error:
        "Cloudflare Access is not configured (CF_ACCESS_AUD is empty), so this Worker refuses to proxy provider requests.",
      status: 503,
    };
  }

  const cookieToken = (request.headers.get("Cookie") || "").match(/CF_Authorization=([^;]+)/);
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || cookieToken?.[1];
  if (!token) return { error: "Unauthorized", status: 401 };

  try {
    const payload = await verifyAccessJwt(token, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_AUD);
    if (!payload.email) return { error: "Unauthorized", status: 401 };
    return { email: payload.email };
  } catch {
    return { error: "Unauthorized", status: 401 };
  }
}
