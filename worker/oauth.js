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
// How long a *superseded* refresh token stays readable. Rotated tokens are
// kept rather than deleted so that presenting one is distinguishable from
// presenting a fabrication — but that only has to cover a realistic theft
// window, not the full refresh lifetime. At the old TTL a connection
// refreshing hourly left ~700 dead rows alive at once, growing with no
// ceiling. Two days is long enough to catch a replay and short enough that
// the rows drain.
const SUPERSEDED_REFRESH_TTL = 2 * 24 * 3600;

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
    revocation_endpoint: `${issuer}/oauth/revoke`,
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

  const existing = await findGrantForClient(env, identity, client.client_id);

  if (request.method === "GET") {
    // Consent already given for this client, covering everything now asked
    // for: don't ask again. A request for anything *beyond* what was granted
    // still goes to the screen — that is a new decision, not a repeat of an
    // old one. Revoking at /connections is what takes the answer back.
    if (existing && scopes.every((scope) => existing.scopes.includes(scope))) {
      audit("reused", {
        client_id: client.client_id,
        identity,
        scopes,
        grant_id: existing.grant_id,
      });
      const target = new URL(redirectUri);
      if (params.state) target.searchParams.set("state", params.state);
      return redirectWithCode(env, {
        target,
        grantId: existing.grant_id,
        client,
        redirectUri,
        params,
        scopes,
        identity,
        origin,
      });
    }

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

  // The grant is created here, at the moment of consent, rather than at token
  // issuance: this is where the person actually decided. Approving again for a
  // client that already has one updates it rather than adding a second, so
  // /connections lists one row per application instead of one per connection.
  const grantId = existing?.grant_id ?? crypto.randomUUID();
  await env.OAUTH.put(
    grantKey(identity, grantId),
    JSON.stringify({
      grant_id: grantId,
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_host: new URL(redirectUri).host,
      identity,
      scopes: granted,
      created_at: existing?.created_at ?? new Date().toISOString(),
      last_token_at: existing?.last_token_at ?? null,
    })
  );

  audit("granted", { client_id: client.client_id, identity, scopes: granted, grant_id: grantId });
  return redirectWithCode(env, {
    target,
    grantId,
    client,
    redirectUri,
    params,
    scopes: granted,
    identity,
    origin,
  });
}

// Mint the authorization code and bounce back to the client. Reached from two
// places: a fresh approval, and a remembered one that skipped the screen.
async function redirectWithCode(env, { target, grantId, client, redirectUri, params, scopes, identity, origin }) {
  const code = randomToken("pgu");
  await env.OAUTH.put(
    `code:${await sha256(code)}`,
    JSON.stringify({
      grant_id: grantId,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: params.code_challenge,
      scopes,
      identity,
      resource: resourceOf(origin),
    }),
    { expirationTtl: CODE_TTL }
  );

  target.searchParams.set("code", code);
  return Response.redirect(target.href, 302);
}

// ---------- grants ----------
//
// A grant is the durable thing a person actually agreed to: this client, this
// identity, these scopes. Tokens are disposable references to it. Without a
// record like this there is nothing to list and nothing to revoke — deleting
// individual token rows by hand is not revocation, it is cleanup.
//
// Keyed by identity so a person's grants can be listed with a prefix scan;
// tokens carry the grant id, and a token whose grant is gone stops working
// everywhere at once.

function grantKey(identity, grantId) {
  return `grant:${identity}:${grantId}`;
}

export async function listGrants(env, identity) {
  const prefix = `grant:${identity}:`;
  const listing = await env.OAUTH.list({ prefix, limit: 100 });
  const grants = await Promise.all(
    listing.keys.map(async (entry) => JSON.parse((await env.OAUTH.get(entry.name)) ?? "null"))
  );
  return grants.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// A grant can be held by more than one connection at a time — the same client
// authorized twice, or two devices. Each gets its own refresh chain, so
// rotating one does not make the other look like a replay. Reuse *within* a
// chain still revokes the whole grant, which is the standard reading: if a
// token was stolen we cannot tell which copy the thief holds.
function chainKey(chainId) {
  return `chain:${chainId}`;
}

export async function findGrantForClient(env, identity, clientId) {
  const grants = await listGrants(env, identity);
  return grants.find((grant) => grant.client_id === clientId) ?? null;
}

export async function revokeGrant(env, identity, grantId) {
  const key = grantKey(identity, grantId);
  const stored = await env.OAUTH.get(key);
  if (!stored) return false;
  await env.OAUTH.delete(key);
  // Tokens are left to expire on their own TTL. They are already dead: every
  // check loads the grant first, so a missing grant is a refused token.
  audit("revoked", { grant_id: grantId, identity, client_id: JSON.parse(stored).client_id });
  return true;
}

// ---------- token ----------

async function issueTokens(env, grant, chainId = crypto.randomUUID(), supersedes = null) {
  const accessToken = randomToken("pgat");
  const refreshToken = randomToken("pgrt");
  const refreshDigest = await sha256(refreshToken);

  const reference = {
    grant_id: grant.grant_id,
    chain_id: chainId,
    client_id: grant.client_id,
    identity: grant.identity,
    scopes: grant.scopes,
    resource: grant.resource,
  };

  await env.OAUTH.put(`token:${await sha256(accessToken)}`, JSON.stringify(reference), {
    expirationTtl: ACCESS_TTL,
  });
  await env.OAUTH.put(`refresh:${refreshDigest}`, JSON.stringify(reference), {
    expirationTtl: REFRESH_TTL,
  });

  // The chain remembers which refresh token is the live one. Any older one
  // presented later is a replay, not a mistake — see the refresh branch.
  await env.OAUTH.put(
    chainKey(chainId),
    JSON.stringify({ grant_id: grant.grant_id, identity: grant.identity, current_refresh: refreshDigest }),
    { expirationTtl: REFRESH_TTL }
  );

  // Shorten the token this one replaces, rather than leaving it to sit for the
  // full refresh lifetime. Rewriting it keeps replay detection working; only
  // its expiry changes.
  if (supersedes) {
    const previous = await env.OAUTH.get(`refresh:${supersedes}`);
    if (previous) {
      await env.OAUTH.put(`refresh:${supersedes}`, previous, {
        expirationTtl: SUPERSEDED_REFRESH_TTL,
      });
    }
  }

  const record = JSON.parse((await env.OAUTH.get(grantKey(grant.identity, grant.grant_id))) ?? "null");
  if (record) {
    record.last_token_at = new Date().toISOString();
    await env.OAUTH.put(grantKey(grant.identity, grant.grant_id), JSON.stringify(record));
  }

  audit("issued", {
    client_id: grant.client_id,
    identity: grant.identity,
    scopes: grant.scopes,
    grant_id: grant.grant_id,
  });
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
      grant_id: record.grant_id,
      client_id: record.client_id,
      identity: record.identity,
      scopes: record.scopes,
      resource: record.resource,
    });
  }

  if (grantType === "refresh_token") {
    const refresh = form.get("refresh_token");
    if (!refresh) return oauthError("invalid_request", "refresh_token is required");

    const digest = await sha256(refresh);
    const stored = await env.OAUTH.get(`refresh:${digest}`);
    if (!stored) return oauthError("invalid_grant", "Unknown or expired refresh token");
    const record = JSON.parse(stored);

    if (record.client_id !== form.get("client_id")) {
      return oauthError("invalid_grant", "Refresh token was issued to a different client");
    }

    // A revoked grant kills every token that references it, without having to
    // hunt those tokens down.
    const grant = JSON.parse(
      (await env.OAUTH.get(grantKey(record.identity, record.grant_id))) ?? "null"
    );
    if (!grant) {
      return oauthError("invalid_grant", "That authorization has been revoked", 400, {
        grant_id: record.grant_id,
      });
    }

    // Rotated refresh tokens are kept until they expire rather than deleted,
    // so presenting a superseded one is distinguishable from presenting a
    // made-up one. Only two things produce it: a client that lost the race, or
    // someone replaying a stolen copy. Both are answered the same way — revoke
    // the whole grant, because we cannot tell which token the thief holds.
    const chain = JSON.parse((await env.OAUTH.get(chainKey(record.chain_id))) ?? "null");
    if (!chain) {
      return oauthError("invalid_grant", "That refresh chain has expired", 400, {
        grant_id: record.grant_id,
      });
    }
    if (chain.current_refresh !== digest) {
      await revokeGrant(env, record.identity, record.grant_id);
      return oauthError("invalid_grant", "Refresh token reuse detected; the grant was revoked", 400, {
        grant_id: record.grant_id,
        client_id: record.client_id,
      });
    }

    // A refresh may narrow scope but never widen it.
    const requested = parseScopes(form.get("scope"));
    if (requested) {
      const widened = requested.filter((scope) => !record.scopes.includes(scope));
      if (widened.length) return oauthError("invalid_scope", "Cannot widen scope on refresh");
      record.scopes = requested;
    }

    // The superseded refresh token is not deleted; issueTokens moves the
    // chain's pointer to the new one and shortens the old one's expiry, which
    // is what keeps replay detectable without keeping it forever.
    return issueTokens(env, record, record.chain_id, digest);
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
  const reference = JSON.parse(stored);

  // The audience check. A token minted for a different MCP server must not
  // work here, even if this server issued it.
  if (reference.resource !== resourceOf(origin)) return null;

  // Revocation is enforced here: an access token is only a pointer, and a
  // pointer to a grant that no longer exists is worth nothing. This costs one
  // KV read per call and is what makes "Revoke" take effect immediately
  // rather than whenever the token happens to expire.
  const grant = await env.OAUTH.get(grantKey(reference.identity, reference.grant_id));
  if (!grant) return null;

  // The grant is already loaded for the revocation check above, so the name the
  // client registered under is free to carry along. Tools that attribute their
  // work use it to say who asked. It is self-asserted -- registration is open,
  // as the spec requires -- so callers must treat it as a label, never as proof
  // of who is calling. A corrupt record should not fail an otherwise valid
  // token, hence the absent name rather than a throw.
  let clientName = null;
  try {
    clientName = JSON.parse(grant).client_name ?? null;
  } catch {
    // Leave it null; the caller has a fallback.
  }

  return {
    identity: reference.identity,
    scopes: reference.scopes,
    clientId: reference.client_id,
    grantId: reference.grant_id,
    clientName,
  };
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

// ---------- revocation (RFC 7009) ----------

// A client handing back a token it no longer needs. Deliberately quiet: the
// spec requires 200 even for an unknown token, so that this endpoint cannot be
// used to test whether a token is valid.
export async function revoke(request, env) {
  if (request.method !== "POST") return oauthError("invalid_request", "POST required", 405);
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("invalid_request", "Expected form-encoded body");

  const presented = form.get("token");
  if (presented) {
    const hint = form.get("token_type_hint");
    // The hint is advice, not truth — try both unless told otherwise.
    const prefixes = hint === "refresh_token" ? ["refresh"] : hint === "access_token" ? ["token"] : ["token", "refresh"];
    const digest = await sha256(String(presented));
    for (const prefix of prefixes) {
      const stored = await env.OAUTH.get(`${prefix}:${digest}`);
      if (!stored) continue;
      const reference = JSON.parse(stored);
      await revokeGrant(env, reference.identity, reference.grant_id);
      break;
    }
  }
  return new Response(null, { status: 200 });
}

// ---------- connected applications ----------

function connectionsPage(grants, identity, notice) {
  const rows = grants.length
    ? grants
        .map((grant) => {
          const scopes = grant.scopes
            .map((scope) => `<code>${escapeHtml(scope)}</code>`)
            .join(" ");
          const used = grant.last_token_at
            ? `last token ${escapeHtml(grant.last_token_at.slice(0, 16).replace("T", " "))} UTC`
            : "no token issued yet";
          return `<li>
            <div class="head"><strong>${escapeHtml(grant.client_name)}</strong>
              <span class="host">${escapeHtml(grant.redirect_host)}</span></div>
            <div class="scopes">${scopes}</div>
            <div class="when">Approved ${escapeHtml(grant.created_at.slice(0, 16).replace("T", " "))} UTC · ${used}</div>
            <form method="POST" action="/connections">
              <input type="hidden" name="grant_id" value="${escapeHtml(grant.grant_id)}" />
              <button type="submit">Revoke</button>
            </form>
          </li>`;
        })
        .join("")
    : `<li class="empty">Nothing is authorized right now.</li>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connected applications</title>
<style>
  :root { color-scheme: light; --bg:#fdfbf5; --fg:#0b4d47; --accent:#c8621f; --muted:#6d827f;
          --border:#ddd9cc; --card:#f7f4ea; --danger:#9d2f2f; }
  body { margin:0; padding:2rem 1rem; font-family:Geneva,sans-serif; background:var(--bg);
         color:var(--fg); line-height:1.5rem; }
  main { max-width:38em; margin:0 auto; }
  h1 { font-size:1.1rem; letter-spacing:.05em; }
  .who { color:var(--muted); font-size:.85rem; }
  .notice { border-left:3px solid var(--accent); background:var(--card); padding:.4rem .7rem;
            font-size:.85rem; margin:1rem 0; }
  ul { list-style:none; padding:0; margin:1.2rem 0; display:grid; gap:.6rem; }
  li { background:var(--card); border:1px solid var(--border); border-radius:3px;
       padding:.7rem .9rem; display:grid; gap:.3rem; }
  li.empty { color:var(--muted); font-size:.9rem; }
  .head { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; }
  .host { color:var(--muted); font-size:.8rem;
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .scopes code { color:#360c97; background:#dadfe0; padding:.1em .3em; font-size:.78rem;
                 margin-right:.25rem; }
  .when { color:var(--muted); font-size:.78rem; }
  form { margin-top:.3rem; }
  button { font:inherit; font-size:.8rem; padding:.3rem .7rem; border-radius:3px;
           border:1px solid var(--border); background:var(--bg); color:var(--danger);
           cursor:pointer; }
  button:hover { border-color:var(--danger); }
  .note { color:var(--muted); font-size:.8rem; margin-top:1.5rem; }
</style></head>
<body><main>
  <h1>Connected applications</h1>
  <p class="who">Signed in as ${escapeHtml(identity)}.</p>
  ${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
  <ul>${rows}</ul>
  <p class="note">Revoking takes effect on the next request — an access token is only a
     pointer to the authorization, so removing it stops every token that referenced it,
     without waiting for one to expire.</p>
</main></body></html>`;
}

export async function connections(request, env, identity) {
  let notice = "";
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const grantId = form?.get("grant_id");
    if (grantId) {
      // Scoped to this identity's own keyspace, so one person cannot revoke
      // another's grant by guessing an id.
      const done = await revokeGrant(env, identity, String(grantId));
      notice = done ? "Access revoked." : "That authorization was already gone.";
    }
  }
  return new Response(connectionsPage(await listGrants(env, identity), identity, notice), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
