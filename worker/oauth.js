// OAuth 2.1 authorization server + resource server, for the MCP endpoint.
//
// Service tokens already work for clients that can set headers. This exists
// for the ones that can't — hosted MCP clients only know how to do OAuth —
// and because a delegated token can carry *part* of the registry, which a
// shared service token can't express.
//
// The shape follows what MCP's HTTP transport expects a server to offer:
//
//   /.well-known/oauth-protected-resource   RFC 9728, points at the issuer
//   /.well-known/oauth-authorization-server RFC 8414, describes the endpoints
//   /oauth/register                         RFC 7591 dynamic registration
//   /oauth/authorize                        consent, behind Access
//   /oauth/token                            code exchange and refresh
//
// Identity is not reinvented: /oauth/authorize sits behind Cloudflare Access,
// so by the time consent is shown the user is already authenticated and the
// resulting token is bound to that identity. This server decides *what* a
// client may do, not *who* the user is.
//
// Notable choices, all of them the point of the exercise:
//   - PKCE (S256) is required, and there are no client secrets. Public
//     clients are the norm for MCP, and a secret a desktop client stores in
//     a config file protects nothing.
//   - Tokens are opaque and stored only as SHA-256 digests, so a dump of the
//     KV namespace does not yield working credentials.
//   - Refresh tokens rotate on use.
//   - The `resource` parameter (RFC 8707) is validated. Without it a token
//     minted for one MCP server could be replayed against another — the
//     confused-deputy problem the MCP spec added resource indicators to close.

import { DEFAULT_SCOPES, SCOPES } from "./tools.js";

const CODE_TTL = 300; // seconds; a code is exchanged immediately in practice
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;

const SCOPE_NAMES = Object.keys(SCOPES);

// ---------- helpers ----------

function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${prefix}_${base64}`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64UrlOf(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Every refusal and every issuance is logged. An authorization server with no
// audit trail can only be debugged by guessing, and "it failed" is what a
// client reports no matter which check said no. Secrets never appear here —
// codes, verifiers, and tokens are identifying, so only their absence or
// mismatch is recorded.
function audit(event, detail) {
  console.log(JSON.stringify({ at: "oauth", event, ...detail }));
}

function oauthError(error, description, status = 400, detail = {}) {
  audit("refused", { error, description, ...detail });
  return Response.json({ error, error_description: description }, { status });
}

function parseScopes(raw) {
  if (!raw) return null;
  return String(raw).split(/\s+/).filter(Boolean);
}

// The canonical identifier for this resource server. A token says which
// resource it was minted for, and the MCP endpoint refuses tokens minted for
// anything else.
//
// The origin is supplied by the caller rather than read from request.url,
// because an issuer identifier has to be stable and exact — clients compare
// the discovered issuer byte-for-byte, and anything that rewrites the request
// URL (a proxy, an asset pipeline, `wrangler dev`) would otherwise change it.
export const RESOURCE_PATH = "/api/mcp";

function resourceOf(origin) {
  return `${origin}${RESOURCE_PATH}`;
}

// A redirect URI must be https, or loopback for a native client. Anything
// else — a custom scheme, a bare hostname — is refused rather than guessed at.
function validRedirectUri(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

// ---------- metadata ----------

export function protectedResourceMetadata(origin) {
  return Response.json({
    resource: resourceOf(origin),
    authorization_servers: [origin],
    scopes_supported: SCOPE_NAMES,
    bearer_methods_supported: ["header"],
  });
}

export function authorizationServerMetadata(origin) {
  const issuer = origin;
  return Response.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: SCOPE_NAMES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}

// ---------- dynamic client registration ----------

export async function register(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }

  const redirectUris = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required");
  }
  if (!redirectUris.every(validRedirectUri)) {
    return oauthError(
      "invalid_redirect_uri",
      "Redirect URIs must be https, or http on a loopback address"
    );
  }

  const clientId = randomToken("pgc");
  const client = {
    client_id: clientId,
    client_name: String(body.client_name ?? "Unnamed client").slice(0, 120),
    redirect_uris: redirectUris,
    created_at: new Date().toISOString(),
  };
  await env.OAUTH.put(`client:${clientId}`, JSON.stringify(client));

  return Response.json(
    {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 }
  );
}

// ---------- authorize ----------

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

// The consent screen. The scope list is the whole point: it names what is
// being handed over in words that mean something, rather than asking for
// blanket access to "your tools" — and each one can be declined on its own,
// because "all of this or nothing" is not really a choice. A client asks for
// what it would like; the person decides what it gets.
function consentPage(client, scopes, identity, params, redirectUri) {
  const rows = scopes
    .map(
      (scope) =>
        `<li><label><input type="checkbox" name="grant" value="${escapeHtml(scope)}" checked />` +
        `<code>${escapeHtml(scope)}</code><span>${escapeHtml(SCOPES[scope])}</span></label></li>`
    )
    .join("");

  // Everything except the checkbox values rides along unchanged, so the POST
  // can be validated against the same request that was displayed.
  const hidden = Object.entries(params)
    .filter(([name, value]) => value && name !== "grant" && name !== "decision")
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${escapeHtml(client.client_name)}</title>
<style>
  :root { color-scheme: light; --bg:#fdfbf5; --fg:#0b4d47; --accent:#c8621f; --muted:#6d827f;
          --border:#ddd9cc; --card:#f7f4ea; --danger:#9d2f2f; }
  body { margin:0; padding:2rem 1rem; font-family:Geneva,sans-serif; background:var(--bg);
         color:var(--fg); line-height:1.5rem; }
  main { max-width:32em; margin:0 auto; }
  h1 { font-size:1.1rem; letter-spacing:.05em; }
  .who { color:var(--muted); font-size:.85rem; }
  .dest { font-size:.85rem; border-left:3px solid var(--accent); padding:.4rem .7rem;
          background:var(--card); }
  .dest strong { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  ul { list-style:none; padding:0; margin:1.2rem 0; display:grid; gap:.5rem; }
  li { background:var(--card); border:1px solid var(--border); border-radius:3px; }
  li label { display:grid; grid-template-columns:auto 1fr; gap:.15rem .6rem;
             padding:.6rem .8rem; cursor:pointer; }
  li input { grid-row:1 / span 2; align-self:center; accent-color:var(--accent);
             width:1.1em; height:1.1em; }
  li code { color:#360c97; background:#dadfe0; padding:.1em .3em; font-size:.8rem;
            justify-self:start; }
  li span { font-size:.9rem; }
  li:has(input:not(:checked)) { opacity:.55; }
  .actions { display:flex; gap:.5rem; margin-top:1.5rem; }
  button { font:inherit; font-size:.9rem; padding:.5rem 1rem; border-radius:3px;
           border:1px solid var(--border); background:var(--bg); color:var(--fg); cursor:pointer; }
  button.approve { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.deny { color:var(--danger); }
  .note { color:var(--muted); font-size:.8rem; margin-top:1.5rem; }
</style></head>
<body><main>
  <h1>Authorize ${escapeHtml(client.client_name)}</h1>
  <p class="who">Signed in as ${escapeHtml(identity)}. This grants access to your
     llm-playground tools until you revoke it.</p>
  <p class="dest">Access will be sent to <strong>${escapeHtml(new URL(redirectUri).host)}</strong>.
     Only approve if you started this from there — the name above is chosen by
     whoever registered the client, and is not proof of who they are.</p>
  <form method="POST" action="/oauth/authorize">
    <ul>${rows}</ul>
    ${hidden}
    <div class="actions">
      <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    </div>
  </form>
  <p class="note">Untick anything you would rather not grant. A client is told what it
     actually received, and cannot widen it later without asking again.</p>
</main></body></html>`;
}

// Validates an authorize request. Returns { client, scopes, params } or a
// Response describing the refusal.
//
// Errors before the redirect_uri is trusted are shown to the user; errors
// after it are redirected back to the client, per the spec — bouncing an
// unvalidated redirect_uri would make this an open redirector.
async function validateAuthorize(params, env, origin) {
  const clientId = params.client_id;
  if (!clientId) return { error: oauthError("invalid_request", "client_id is required") };

  const stored = await env.OAUTH.get(`client:${clientId}`);
  if (!stored) return { error: oauthError("invalid_client", "Unknown client_id") };
  const client = JSON.parse(stored);

  const redirectUri = params.redirect_uri;
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { error: oauthError("invalid_request", "redirect_uri does not match registration") };
  }

  const back = (error, description) => {
    audit("refused", { error, description, client_id: clientId, via: "redirect" });
    const target = new URL(redirectUri);
    target.searchParams.set("error", error);
    target.searchParams.set("error_description", description);
    if (params.state) target.searchParams.set("state", params.state);
    return { error: Response.redirect(target.href, 302) };
  };

  if (params.response_type !== "code") return back("unsupported_response_type", "Expected code");
  if (params.code_challenge_method !== "S256") return back("invalid_request", "PKCE S256 required");
  if (!params.code_challenge) return back("invalid_request", "code_challenge is required");

  // RFC 8707: if the client names a resource, it must be this one.
  if (params.resource && params.resource !== resourceOf(origin)) {
    return back("invalid_target", "Unknown resource");
  }

  const requested = parseScopes(params.scope) ?? DEFAULT_SCOPES;
  const unknown = requested.filter((scope) => !SCOPE_NAMES.includes(scope));
  if (unknown.length) return back("invalid_scope", `Unknown scope: ${unknown.join(", ")}`);

  return { client, scopes: requested, params, redirectUri };
}

export async function authorize(request, env, identity, origin) {
  // The request arrives twice: as a GET carrying the parameters in the query
  // string, then as the consent form's POST carrying them back as hidden
  // fields. Read from whichever the method implies — a POST has no query
  // string of its own, so reading only searchParams loses every parameter.
  let params;
  let form = null;
  if (request.method === "POST") {
    form = await request.formData();
    params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  } else {
    params = Object.fromEntries(new URL(request.url).searchParams);
  }

  const validated = await validateAuthorize(params, env, origin);
  if (validated.error) return validated.error;

  const { client, scopes, redirectUri } = validated;

  if (request.method === "GET") {
    return new Response(consentPage(client, scopes, identity, params, redirectUri), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const target = new URL(redirectUri);
  if (params.state) target.searchParams.set("state", params.state);

  // Read the ticked boxes from the form rather than from `params`, which
  // collapsed the repeated field down to its last value.
  const ticked = form.getAll("grant").map(String);
  // Only ever a subset of what was displayed: a tampered form cannot grant
  // more than the client asked for.
  const granted = scopes.filter((scope) => ticked.includes(scope));

  // Nothing ticked is a refusal, not an empty grant — a token that can do
  // nothing would look like success to the client.
  if (form.get("decision") !== "approve" || granted.length === 0) {
    audit("refused", {
      error: "access_denied",
      description: form.get("decision") === "approve" ? "approved with no scopes ticked" : "denied",
      client_id: client.client_id,
      identity,
    });
    target.searchParams.set("error", "access_denied");
    return Response.redirect(target.href, 302);
  }

  const code = randomToken("pgu");
  await env.OAUTH.put(
    `code:${await sha256(code)}`,
    JSON.stringify({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: params.code_challenge,
      scopes: granted,
      identity,
      resource: resourceOf(origin),
    }),
    { expirationTtl: CODE_TTL }
  );

  audit("granted", { client_id: client.client_id, identity, scopes: granted });
  target.searchParams.set("code", code);
  return Response.redirect(target.href, 302);
}

// ---------- token ----------

async function issueTokens(env, grant) {
  const accessToken = randomToken("pgat");
  const refreshToken = randomToken("pgrt");

  await env.OAUTH.put(`token:${await sha256(accessToken)}`, JSON.stringify(grant), {
    expirationTtl: ACCESS_TTL,
  });
  await env.OAUTH.put(`refresh:${await sha256(refreshToken)}`, JSON.stringify(grant), {
    expirationTtl: REFRESH_TTL,
  });

  audit("issued", { client_id: grant.client_id, identity: grant.identity, scopes: grant.scopes });
  return Response.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    refresh_token: refreshToken,
    scope: grant.scopes.join(" "),
  });
}

export async function token(request, env) {
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);

  const form = await request.formData().catch(() => null);
  if (!form) {
    return oauthError("invalid_request", "Expected form-encoded body", 400, {
      content_type: request.headers.get("content-type"),
    });
  }
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code");
    if (!code) return oauthError("invalid_request", "code is required");

    const key = `code:${await sha256(code)}`;
    const stored = await env.OAUTH.get(key);
    if (!stored) return oauthError("invalid_grant", "Unknown or expired code");
    // Single use: delete before doing anything else with it.
    await env.OAUTH.delete(key);
    const record = JSON.parse(stored);

    if (record.client_id !== form.get("client_id")) {
      return oauthError("invalid_grant", "Code was issued to a different client", 400, {
        expected_client: record.client_id,
        presented_client: form.get("client_id"),
      });
    }
    if (record.redirect_uri !== form.get("redirect_uri")) {
      return oauthError("invalid_grant", "redirect_uri does not match the authorization", 400, {
        expected_redirect: record.redirect_uri,
        presented_redirect: form.get("redirect_uri"),
      });
    }

    const verifier = form.get("code_verifier");
    if (!verifier) return oauthError("invalid_request", "code_verifier is required");
    const digest = base64UrlOf(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    );
    if (digest !== record.code_challenge) {
      return oauthError("invalid_grant", "code_verifier does not match the challenge");
    }

    return issueTokens(env, {
      client_id: record.client_id,
      identity: record.identity,
      scopes: record.scopes,
      resource: record.resource,
    });
  }

  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token");
    if (!refresh) return oauthError("invalid_request", "refresh_token is required");

    const key = `refresh:${await sha256(refresh)}`;
    const stored = await env.OAUTH.get(key);
    if (!stored) return oauthError("invalid_grant", "Unknown or expired refresh token");
    const record = JSON.parse(stored);

    if (record.client_id !== form.get("client_id")) {
      return oauthError("invalid_grant", "Refresh token was issued to a different client");
    }

    // A refresh may narrow scope but never widen it.
    const requested = parseScopes(form.get("scope"));
    if (requested) {
      const widened = requested.filter((scope) => !record.scopes.includes(scope));
      if (widened.length) return oauthError("invalid_scope", "Cannot widen scope on refresh");
      record.scopes = requested;
    }

    // Rotate only once the request is known good. Spending the token on a
    // rejected request would let one malformed refresh destroy a working
    // grant — unlike an authorization code, where a failed exchange is
    // evidence of interception and burning it is the point.
    await env.OAUTH.delete(key);
    return issueTokens(env, record);
  }

  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
}

// ---------- resource server ----------

// Verifies a Bearer token for the MCP endpoint. Returns { identity, scopes }
// or null; the caller turns null into a 401 carrying the metadata pointer.
export async function verifyBearer(request, env, origin) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const stored = await env.OAUTH.get(`token:${await sha256(match[1])}`);
  if (!stored) return null;
  const grant = JSON.parse(stored);

  // The audience check. A token minted for a different MCP server must not
  // work here, even if this server issued it.
  if (grant.resource !== resourceOf(origin)) return null;

  return { identity: grant.identity, scopes: grant.scopes, clientId: grant.client_id };
}

// The 401 that starts discovery: it tells the client where to find the
// metadata describing how to get a token.
export function unauthorized(origin, description = "A bearer token is required") {
  const metadata = `${origin}/.well-known/oauth-protected-resource`;
  return Response.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${metadata}", error="invalid_token"`,
      },
    }
  );
}
