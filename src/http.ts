#!/usr/bin/env node
/**
 * The REMOTE entry point — the same nine tools over Streamable HTTP.
 *
 * Why this file exists at all: a web client cannot run a process on the user's
 * machine, so claude.ai and ChatGPT can never reach the stdio package however
 * well it works. They speak to a URL or to nothing. This is that URL.
 *
 *   node dist/http.js        → listens on VIDOFY_MCP_PORT, path /mcp-app
 *   node dist/index.js       → the stdio server, unchanged
 *
 * In production nginx terminates TLS on vidofy.ai and proxies /mcp-app here;
 * this process never sees the internet directly and never holds a certificate.
 *
 * IT IS OAUTH NOW — and the two paragraphs that used to stand here said the
 * opposite
 * ------------------------------------------------------------------------
 * They described a staging step ("it is not OAuth… a fixed bearer header… NOT
 * the shipping shape") and were true for about a day. They are left mentioned
 * rather than silently deleted because the thing they got wrong is worth
 * knowing: the staged shape is now **impossible**, not merely superseded. A
 * hand-made `vmt_` from the tokens page declares NO resource, this
 * endpoint always declares a resource (see MCP_PATH below), and the server
 * refuses that pairing outright. So "No sign-in
 * + Request headers" cannot work here any more, and a reader who trusted those
 * paragraphs would spend an afternoon finding out.
 *
 * What is built: authorization (`/mcp-app/authorize`), the consent hand-off to
 * PHP, the code exchange (`/mcp-app/token`), Client ID Metadata Documents, PKCE
 * S256, and RFC 8707 audience binding. What is NOT built: token revocation over
 * the protocol — revocation lives on the website's own tokens page, which is why
 * `revocation_endpoint` is absent from the metadata below rather than advertised
 * and unrouted.
 *
 * STATELESS ON PURPOSE
 * --------------------
 * sessionIdGenerator is undefined, so every request stands alone. That is a
 * measured fit rather than a simplification: this server never pushes a
 * notification (zero sendNotification calls in the package), because the card
 * polls get_status through the host instead. Sessions exist to carry
 * server-initiated messages; with none to carry, holding per-session state would
 * be a memory leak with a session id on it.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { buildServer, log, readVersion } from './index.js';
import { request, VidofyError } from './backend.js';
import { configForToken, ConfigError, resolveBaseUrl, type Config } from './config.js';
import { handleAuthorize, handleAuthorizeDecide } from './oauth/authorize.js';
import { handleToken } from './oauth/token.js';
import { startHeartbeat } from './heartbeat.js';
import {
    hitLimit, AUTHORIZE_PER_IP, AUTHORIZE_PER_CLIENT, DECIDE_PER_IP, TOKEN_PER_IP,
} from './oauth/ratelimit.js';

/**
 * Is this a development run?
 *
 * Decided from the site origin this process talks to, which is the same signal
 * config.ts already uses to allow plain http — not a separate flag that could
 * disagree with it. Anything pointing at vidofy.ai is production by definition.
 */
function isLocalDevelopment(): boolean {
    const host = new URL(resolveBaseUrl()).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
        || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.test');
}

/** The path nginx proxies here. Not `/mcp` — that prefix would also match the landing page. */
const MCP_PATH = '/mcp-app';

const DEFAULT_PORT = 2097;

/** Ceiling on a request body. See the enforcement note at the MCP endpoint. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The one MCP handler, built on first use.
 *
 * `legacy: 'stateless'` is the default and is stated anyway, because it is the
 * whole compatibility story in one word: a host speaking the 2026-07-28 envelope
 * gets a modern instance and its capabilities arrive per request; a host still
 * speaking 2025 gets a fresh stateless instance exactly as before this migration.
 * One factory serves both, so the tools are defined once — and the alternative,
 * `legacy: 'reject'`, would have cut off every client that has not moved yet.
 *
 * The factory runs PER REQUEST, so nothing about the stateless design changed. What
 * changed is that the library owns the transport instead of this file.
 *
 * Lazily built because `version` is read at boot and this is module scope; memoised
 * because a handler per request would defeat the point of it owning anything.
 */
let handlerSingleton: ReturnType<typeof createMcpHandler> | null = null;
function mcpHandler(version: string): ReturnType<typeof createMcpHandler> {
    if (handlerSingleton !== null) return handlerSingleton;
    handlerSingleton = createMcpHandler(
        (ctx) => {
            /* The Config we already built and verified, handed over rather than
             * re-derived. FAIL CLOSED if it is missing: serving a request with a
             * default or a guessed credential is how one user spends another's
             * coins, so a wiring mistake must be an error and never a fallback. */
            const cfg = (ctx.authInfo?.extra as { cfg?: Config } | undefined)?.cfg;
            if (cfg === undefined) {
                throw new Error('MCP handler reached with no Config in authInfo.extra — refusing.');
            }
            /* Logged because it is the single most useful fact when a card does not
               appear: `modern` means the client's capabilities ride every request and
               the UI gate can see them; `legacy` means they cannot, by construction,
               and no amount of looking at the card code will explain it. */
            log(`serving ${ctx.era} era`);
            return buildServer(cfg, version) as unknown as ReturnType<typeof buildServer>;
        },
        {
            legacy: 'stateless',
            onerror: (err) => log(`mcp: ${err.message}`),
        }
    );
    return handlerSingleton;
}

/**
 * This server's own public origin — the one a client sees.
 *
 * It matters because OAuth discovery is built on identifiers, not on paths: the
 * `resource` in the protected-resource document and the `issuer` in the
 * authorization-server document must be the URLs the client actually used, or
 * the client rejects the documents as belonging to someone else.
 *
 * VIDOFY_MCP_PUBLIC_URL wins when set. The header fallback exists for the
 * cloudflared tunnel, whose hostname is issued fresh on every run and so cannot
 * be configured ahead of time.
 *
 * ⚠ THE OLD VERSION OF THIS FUNCTION CALLED THAT FALLBACK "development only" AND
 * GATED IT ON NOTHING. Measured 2026-09-12 against the real process, with the
 * env var unset — which was production's default, since the variable appears in
 * no deploy artifact:
 *
 *   X-Forwarded-Host: attacker.example
 *     → {"issuer":"https://attacker.example",
 *        "token_endpoint":"https://attacker.example/mcp-app/token"}
 *   X-Forwarded-Proto: javascript   → "issuer":"javascript://evil"
 *
 * Two consequences, and the second is worse than the first. A client that trusts
 * the authorization-server document is sent to the attacker's token endpoint. And
 * the same value becomes the canonical `resource` bound into every token this
 * flow mints, so a proxy that merely ADDS X-Forwarded-Host — no attacker needed —
 * mints tokens whose audience never matches, and every one of them is refused
 * later with the single word "audience".
 *
 * So the fallback is now gated on isLocalDevelopment(), which is derived from the
 * site origin rather than from anything a request can set, and the value is run
 * through resolveBaseUrl() — the same validation VIDOFY_API_BASE gets — so a
 * scheme like `javascript:` or a host with a quote in it cannot survive. In
 * production a missing variable is a BOOT FAILURE (see main), not a silent
 * fallback to whatever the last hop claimed.
 */
function publicOrigin(req: IncomingMessage): string {
    const configured = (process.env['VIDOFY_MCP_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
    if (configured !== '') return configured;

    /* Unreachable in production: main() refuses to boot without the variable.
       Kept as a guard rather than an assertion because this function is also
       called from the 401 path, and a 401 that throws is a 500. */
    if (!isLocalDevelopment()) return resolveBaseUrl();

    const hdr = (name: string): string => {
        const v = req.headers[name];
        return (Array.isArray(v) ? v[0] : v) ?? '';
    };
    const host = hdr('x-forwarded-host') || hdr('host') || '127.0.0.1';
    const proto = hdr('x-forwarded-proto') || (host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 'http' : 'https');

    /* Validated even here. A tunnel hostname is still a header value, and the
       development path is where this code is exercised most — a rule that only
       runs in production is a rule nobody has tested. */
    try {
        return resolveBaseUrl({ VIDOFY_API_BASE: `${proto}://${host}` });
    } catch {
        return resolveBaseUrl();
    }
}

/**
 * OAuth discovery — the two documents.
 *
 * ⚠ THEY ARE HAND-WRITTEN, RIGHT HERE. That needs saying because the plan
 * document and a commit message both claimed the SDK generates them
 * ("server/auth/router.js:97,99, so no JSON is written by hand and it cannot
 * drift from reality"). The SDK *can*; we do not use it — `grep -r "server/auth"
 * src/` is zero. So the failure mode that claim ruled out is exactly the one we
 * have: **every path below is duplicated from the routes further down this file,
 * and nothing checks that the two agree.** One already disagreed —
 * `revocation_endpoint` was advertised here with no route behind it.
 *
 * So: change a route, change it here, in the same edit.
 *
 * It began as a PROBE rather than a feature (owner decision 2026-09-12): publish
 * the documents first and watch what each host asks for next, instead of writing
 * the flow they would drive. That is how we learned claude.ai wants protocol
 * 2026-07-28 — a fact no amount of reading produced. The flow behind them is
 * built now.
 *
 * The probe ran on 2026-09-12 and answered the question it was built for.
 * Advertising both client-registration mechanisms at once — `registration_endpoint`
 * (Dynamic Client Registration) and `client_id_metadata_document_supported` — made
 * it report a preference rather than a capability, and both hosts picked the same
 * one:
 *
 *   claude.ai  client_id = https://claude.ai/oauth/mcp-oauth-client-metadata
 *   ChatGPT    client_id = https://chatgpt.com/oauth/<per-connector>/client.json
 *   calls to /register = ZERO, from either
 *
 * So `registration_endpoint` is GONE from the document below. It was honest while
 * it was an instrument; keeping it now would advertise a path we will not build
 * to clients that never ask for it.
 *
 * (That sentence used to be followed by "the remaining endpoints are still
 * unbuilt". They are built — authorize, the consent hand-off, and token.)
 */
function discoveryDocuments(origin: string): {
    protectedResource: Record<string, unknown>;
    authorizationServer: Record<string, unknown>;
} {
    const resource = `${origin}${MCP_PATH}`;
    return {
        // RFC 9728. `resource` MUST be the canonical URI the client called.
        protectedResource: {
            resource,
            authorization_servers: [origin],
            scopes_supported: ['vidofy.generate'],
            bearer_methods_supported: ['header'],
            resource_name: 'Vidofy',
            resource_documentation: 'https://vidofy.ai/en/mcp',
        },
        // RFC 8414.
        authorizationServer: {
            issuer: origin,
            authorization_endpoint: `${origin}${MCP_PATH}/authorize`,
            token_endpoint: `${origin}${MCP_PATH}/token`,
            /* No `revocation_endpoint`. It was advertised here pointing at
               `${MCP_PATH}/revoke`, which 404s — the same false advertisement that
               got `registration_endpoint` deleted above, made twice in one
               document. Revocation is real but it lives on the website
               (/en/studio/account/mcp-tokens), where the user can see which client
               a token belongs to before killing it; RFC 7009 is optional and a
               client that cannot revoke loses nothing it had. */
            response_types_supported: ['code'],
            /* `refresh_token` is NOT advertised: the decision is one long-lived
               access token and no refresh, which the spec
               permits outright — "MCP Clients MUST NOT assume refresh tokens
               will be issued; the AS retains discretion". Both hosts list
               refresh_token in their own metadata, which says what they accept,
               not what they require. */
            grant_types_supported: ['authorization_code'],
            // PKCE is mandatory in OAuth 2.1, and S256 is the only method worth
            // advertising — `plain` exists in the RFC for clients that cannot
            // hash, which no MCP client is.
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['vidofy.generate'],
            client_id_metadata_document_supported: true,
        },
    };
}

/**
 * The caller's address, for rate limiting.
 *
 * ⚠ THE LAST X-Forwarded-For ENTRY, NOT THE FIRST — and this is the opposite of
 * the usual advice, so it needs the reason.
 *
 * nginx is configured with `proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for`, which APPENDS the peer it actually observed to
 * whatever the client sent. So the header arrives as
 *
 *     <anything the caller invented>, <the address nginx saw>
 *
 * Reading the first entry reads the attacker's own string, which means every
 * request can claim a different address and the limiter counts nothing. The last
 * entry is the only one nginx wrote, and the only one worth trusting.
 *
 * ⚠ AND IT DEPENDS ON THAT DIRECTIVE EXISTING. Whoever deploys this behind a
 * proxy must set it. Without the header, every request looks like
 * 127.0.0.1 and the per-IP bucket becomes one global bucket for all users —
 * a limiter that locks everyone out together. That is why a loopback peer with no
 * header is LOGGED, loudly and once: it is a misconfiguration that would otherwise
 * look like a mysterious 429 storm.
 */
let warnedAboutMissingForwardedFor = false;
function clientAddress(req: IncomingMessage): string {
    const raw = req.headers['x-forwarded-for'];
    const header = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    if (header.trim() !== '') {
        const parts = header.split(',').map((s) => s.trim()).filter((s) => s !== '');
        const last = parts[parts.length - 1];
        if (last !== undefined && last !== '') return last;
    }

    const peer = req.socket.remoteAddress ?? 'unknown';
    const isLoopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (isLoopback && !warnedAboutMissingForwardedFor) {
        warnedAboutMissingForwardedFor = true;
        log('⚠ no X-Forwarded-For and the peer is loopback, so every caller looks like one '
            + 'address and the per-IP rate limits are effectively global. Add '
            + '`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` to the nginx '
            + 'block. (Harmless in local development, where there is one caller.)');
    }
    return peer;
}

/**
 * Apply a rate limit and answer 429 if it is spent.
 *
 * @returns true when the caller may proceed.
 */
async function rateLimited(
    res: ServerResponse,
    bucket: string,
    spec: { limit: number; windowSec: number }
): Promise<boolean> {
    const verdict = await hitLimit(bucket, spec.limit, spec.windowSec);
    if (verdict.allowed) return false;

    /* Retry-After is exact — seconds until this fixed window resets — which is the
       same contract the Partners API documents. A guessed number sends the caller
       back into the same refusal. */
    res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(verdict.retryAfter),
    });
    res.end(JSON.stringify({
        error: 'rate_limited',
        error_description: `Too many requests. Try again in ${verdict.retryAfter}s.`,
    }, null, 2));
    log(`429 ${bucket} — ${verdict.count < 0 ? 'limiter unavailable' : `${verdict.count} in window`}`);
    return true;
}

/** Bearer token from the Authorization header, or '' when absent/malformed. */
function bearerToken(req: IncomingMessage): string {
    const raw = req.headers['authorization'];
    const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m?.[1]?.trim() ?? '';
}

/**
 * A 401 that tells the client what to do.
 *
 * It DOES carry `resource_metadata` — an earlier version of this comment said the
 * omission was deliberate "until OAuth exists", and OAuth exists.
 */
function unauthorized(res: ServerResponse, message: string, resourceMetadata?: string): void {
    /* The header is FIXED and the explanation goes in the body only.
     *
     * Interpolating `message` here threw on the very first request and answered
     * "500 Unauthorized" — a status line that names two different outcomes,
     * which is about the worst thing to hand someone debugging a connector. The
     * cause: our own messages contain a typographic ellipsis ("vmt_…"), and Node
     * rejects any header value outside latin1 with ERR_INVALID_CHAR, so
     * writeHead threw after having already set statusMessage from the 401.
     *
     * Sanitising the string would fix the throw and keep the hazard: every
     * future message becomes a chance to break the response by adding a dash or
     * a quote. So nothing variable goes into a header. `WWW-Authenticate` is for
     * the client's parser and carries only what the parser uses; the human
     * sentence travels in JSON, where UTF-8 is the point. */
    /* `resource_metadata` is the ONE variable part allowed in. It turns a dead
     * 401 into a discoverable one: the client reads that URL to find the
     * authorization server (RFC 9728 §5.1), the step claude.ai failed at before
     * these documents existed.
     *
     * ⚠ AND THE PARAGRAPH ABOVE WAS WRONG ABOUT IT. It said this value is safe
     * because it is "a URL — ASCII by construction". It is not constructed; it is
     * derived from a request header, so it was neither ASCII nor quote-free.
     * Measured 2026-09-12:
     *
     *   Host: a", error="injected
     *     → www-authenticate: Bearer error="invalid_token",
     *       resource_metadata="https://a", error="injected/.well-known/…"
     *
     * An injected auth-param, in the one header a client's auth logic parses. The
     * value is now URL-parsed and re-serialised through encodeURI, and refused
     * outright if it still contains a quote, a backslash, a control character or
     * anything outside latin1. Belt and braces on purpose: publicOrigin() already
     * validates its input, and this is the place where being wrong is a protocol
     * bug in someone else's parser rather than ours. */
    const safeMetadata = ((): string | null => {
        if (resourceMetadata === undefined) return null;
        let parsed: URL;
        try {
            parsed = new URL(resourceMetadata);
        } catch {
            return null;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        /* encodeURI escapes `"` to %22 and `\` to %5C, percent-encodes every
           control character, and percent-encodes non-ASCII as UTF-8 — so the
           result cannot close the quoted string, cannot append a parameter, and
           cannot reintroduce ERR_INVALID_CHAR. The previous version of this line
           tested the same thing with LITERAL control bytes in the source (NUL,
           0x1F, 0x7F, U+FFFF inside a character class) — correct, and unreadable,
           and impossible to review in a diff. */
        const encoded = encodeURI(parsed.toString());
        // The assertion, not the defence: printable ASCII, no quote, no backslash.
        const safe = /^[\x21-\x7E]+$/.test(encoded)
            && !encoded.includes('"') && !encoded.includes('\\');
        return safe ? encoded : null;
    })();

    res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer error="invalid_token"'
            + (safeMetadata !== null ? `, resource_metadata="${safeMetadata}"` : '')
            + ', scope="vidofy.generate"',
    });
    res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message },
        id: null,
    }));
}

/** Serve a discovery document as JSON. */
function sendJson(res: ServerResponse, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // Clients cache these; a short TTL keeps a corrected document reachable
        // without making every handshake pay for a fetch.
        'cache-control': 'public, max-age=300',
    });
    res.end(text);
}

async function handle(req: IncomingMessage, res: ServerResponse, version: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = publicOrigin(req);

    /* PROBE LOG — the reason this step exists at all.
     *
     * Every request, with the method and path, and whether a credential came
     * with it. NOT the credential itself: a log that quotes a bearer token turns
     * a debugging aid into a leak, and this file's whole job is handling
     * credentials. Presence answers every question the value would. */
    log(`→ ${req.method ?? '?'} ${url.pathname}${url.search}`
        + (req.headers['authorization'] !== undefined ? ' [auth: present]' : ' [auth: none]'));

    const docs = discoveryDocuments(origin);

    /* RFC 9728 appends the resource's own path to the well-known name, so a host
       can carry several protected resources. The bare form is served too because
       some clients look there first — same document either way, since this server
       has exactly one resource. */
    if (url.pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`
        || url.pathname === '/.well-known/oauth-protected-resource') {
        sendJson(res, docs.protectedResource);
        return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
        sendJson(res, docs.authorizationServer);
        return;
    }

    if (url.pathname === `${MCP_PATH}/token`) {
        if (await rateLimited(res, `token:ip:${clientAddress(req)}`, TOKEN_PER_IP)) return;
        await handleToken(req, res);
        return;
    }

    if (url.pathname === `${MCP_PATH}/authorize/decide`) {
        if (await rateLimited(res, `decide:ip:${clientAddress(req)}`, DECIDE_PER_IP)) return;
        await handleAuthorizeDecide(res, url);
        return;
    }

    if (url.pathname === `${MCP_PATH}/authorize`) {
        /* GET only. The endpoint reads the query string and nothing else, so any
           other method is either a mistake or someone shipping a body we would
           accept and ignore — and this is the one route that opens an outbound
           connection, so it gets the cheapest possible guards first. */
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET' });
            res.end(JSON.stringify({
                error: 'invalid_request',
                error_description: 'The authorization endpoint accepts GET.',
            }, null, 2));
            return;
        }

        /* TWO buckets, and the order matters: per-IP first because it is the one
         * that stops the ordinary single-source flood, then per-client_id, which is
         * what survives an attacker spread across many addresses.
         *
         * The client_id is read straight from the query and used as a bucket name,
         * so it is HASHED rather than concatenated: it is an arbitrary URL from an
         * unauthenticated caller, and letting it into a Redis key verbatim would let
         * someone choose our key space — length, colons, whatever ':' means to a
         * pattern someone later writes. A short hash is enough to separate clients
         * and cannot be steered. */
        if (await rateLimited(res, `authorize:ip:${clientAddress(req)}`, AUTHORIZE_PER_IP)) return;
        const rawClientId = (url.searchParams.get('client_id') ?? '').trim();
        if (rawClientId !== '') {
            const clientBucket = createHash('sha256').update(rawClientId).digest('hex').slice(0, 16);
            if (await rateLimited(res, `authorize:client:${clientBucket}`, AUTHORIZE_PER_CLIENT)) return;
        }

        /* The canonical resource is built from THIS server's own origin, not from
           the `resource` parameter — the parameter is what we check against it.
           allowPrivateClients follows the same development exception the site's
           own SSRF validator carries, so the flow can be exercised
           against a local stub without weakening production. */
        await handleAuthorize(res, url, `${origin}${MCP_PATH}`, {
            ...(isLocalDevelopment() ? { allowPrivateClients: true } : {}),
        });
        return;
    }

    if (url.pathname !== MCP_PATH) {
        /* The message lists what IS served, because the previous one ("serves
           /mcp-app only") became false the moment the discovery documents were
           added — and a 404 that misdescribes the server is what sends someone
           looking for a routing bug that is not there. The probe hit it on
           /mcp-app/authorize and the wrong text was the first thing read. */
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            error: 'NOT_FOUND',
            message: `No handler for ${url.pathname}.`,
            served: [
                MCP_PATH,
                `/.well-known/oauth-protected-resource${MCP_PATH}`,
                '/.well-known/oauth-authorization-server',
            ],
        }));
        return;
    }

    /* Refuse an oversized body BEFORE anything costly — before the token check
     * below, which is a network round trip.
     *
     * The transport reads the whole body before parsing and imposes no limit of
     * its own on this path (the SDK's 4 MB cap lives only in the SSE transport).
     * Measured 2026-09-12: an 80 MB POST was accepted and took the process from
     * 92 MB to 403 MB resident. A handful in parallel is the whole connector, and
     * the same process serves the OAuth endpoints.
     *
     * 1 MB is generous for the largest legitimate request here — a tool call whose
     * arguments are text and URLs. Uploads do not travel this way: generate sends
     * file paths and the backend fetches them.
     *
     * content-length is only a claim, so this is the cheap half; the stream is
     * counted too, further down. */
    const declaredLength = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32600, message: `Request body may not exceed ${MAX_BODY_BYTES} bytes.` },
            id: null,
        }));
        return;
    }

    /* Build the caller's Config BEFORE the transport touches the body. A bad
       credential is answered with one 401 rather than becoming a JSON-RPC error
       inside a stream the client then has to unwrap. */
    let cfg;
    try {
        /* The connector declares its own canonical resource, so /app/v1 can
           check the token's audience. A hand-made token has none recorded and is
           therefore refused HERE, at the connector — which is the direction of
           the check that matters, since the caller cannot change what we send. */
        cfg = configForToken(bearerToken(req), process.env, version, `${origin}${MCP_PATH}`);
    } catch (err) {
        unauthorized(
            res,
            err instanceof ConfigError ? err.message : 'Authentication failed.',
            `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`
        );
        return;
    }

    /* ── And now PROVE the token, instead of trusting its first four characters ──
     *
     * configForToken above checks the shape: it starts with `vmt_`. That is all it
     * can check — only the site can verify a token. For a while
     * that was the whole gate, and the consequence was measured on 2026-09-12:
     *
     *   Authorization: Bearer vmt_totally_fake_never_issued
     *     → the full nine-tool tools/list, 200 OK
     *
     * Every tool that spends money authenticates again at /app/v1, so the wallet
     * was never open. But four tools read anonymous /app/v1/info/* routes and
     * needed no credential at all, tools/list needed none, and the 401 this file
     * takes such care over was decoration on those paths. The MCP authorization
     * spec is not ambiguous about it either: the resource server MUST validate
     * that the token was issued for it.
     *
     * So one authenticated call, before anything is dispatched. `account/balance`
     * is the probe rather than a new endpoint, deliberately: it is already what
     * get_balance calls, it requires the session token, and because request()
     * sends X-Vidofy-MCP-Resource it validates the AUDIENCE in the same round
     * trip — a hand-made token and an OAuth token for a different connector both
     * fail here, in PHP, which is the only place that can tell.
     *
     * The cost is one extra round trip per MCP request (owner decision A,
     * 2026-09-12, with the alternative — leave PHP as the only authority and
     * correct the claim instead — considered and declined). It buys a connector
     * whose 401 means what it says. */
    try {
        /* ONE attempt, TEN seconds — not the defaults, and this is load-bearing.
         *
         * request() defaults to MAX_ATTEMPTS 4 at DEFAULT_TIMEOUT_MS 60_000 each,
         * and attempts compose by adding (see the note above DEFAULT_TIMEOUT_MS).
         * With those defaults a backend answering 503 would make this check alone
         * take up to four minutes — in front of EVERY MCP request, and in front of
         * `generate`, whose own 50s budget exists because the client gives up at
         * 60. The gate would have become the outage.
         *
         * One attempt is right rather than merely cheap: the answer that matters
         * here is 401/403, which isRetryableStatus already excludes from retrying,
         * so a retry could only ever help a transient 5xx — and for that, failing
         * fast with an honest 503 the client can retry whole is better than
         * holding its connection open.
         *
         * WHY TEN AND NOT FIVE (owner decision, 2026-09-13). Five was chosen on the
         * shape of the work — a single indexed read answers in milliseconds — and
         * then measured against reality on a development Mac: EVERY call to a
         * `.local` host costs 5.0s before the request even starts, because macOS
         * routes that suffix through mDNS and `/etc/hosts` does not short-circuit
         * it (`dscacheutil` on a name that IS in the file: 5.013s; the same request
         * with `--resolve`: 0.085s). So the budget was spent entirely on name
         * resolution and every local tool call answered 503 — a healthy connector
         * refusing a valid token, for a reason nowhere near the code.
         *
         * The narrower fix was an override set only in the local supervisor
         * program, keeping production at five. The owner chose ten for every
         * environment instead, and the trade it makes is worth stating plainly:
         * when the site really is unreachable, a caller now waits ten seconds for
         * the refusal rather than five. That is the whole cost — this path cannot
         * hold longer than one attempt, and nothing downstream shortens. */
        await request(cfg, { method: 'GET', path: 'account/balance', maxAttempts: 1, timeoutMs: 10_000 });
    } catch (err) {
        /* Only an auth failure is a 401. A backend outage must not be reported as
           "your token is invalid" — that sends the user to revoke a good token and
           re-run consent for nothing. VidofyError carries the HTTP status; 401/403
           are the token's fault, anything else is ours. */
        const status = err instanceof VidofyError ? err.httpStatus : null;
        if (status === 401 || status === 403) {
            unauthorized(
                res,
                'This token is not valid for this connector. It may have been revoked, '
                + 'expired, or issued for a different server — reconnect to get a new one.',
                `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`
            );
            return;
        }
        log(`token check could not complete: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32003, message: 'Vidofy is not reachable right now. Try again shortly.' },
            id: null,
        }));
        return;
    }

    /* ── Hand the request to the v2 handler ──────────────────────────────────
     *
     * One `createMcpHandler` for the process (built at module scope below), not a
     * transport per request. The FACTORY is still per request — that is the shape
     * v2 provides — so nothing about the stateless design changed; what changed is
     * who owns the plumbing.
     *
     * The Config travels in `authInfo.extra`, which is the library's own
     * pass-through: "the handler never populates this from request headers and
     * performs no token verification of its own". That division is exactly ours —
     * we verified the bearer above, twice (shape here, then PHP), and the handler
     * is told the answer rather than asked to find it. `resource` is set too
     * because it is the RFC 8707 field by name, and a reader of a log or a dump
     * should see the audience where the spec puts it. */
    const body = await readBodyCapped(req, res);
    if (body === null) return;      // already answered (413) and the socket cut

    /* From here the request is v2's to judge, and on the modern route it judges
     * FOUR things this endpoint does not check itself — deliberately, because
     * checking them twice would put two sets of rules on one wire:
     *
     *   1. an `Mcp-Method` header,      2. naming the same method as the body,
     *   3. `_meta["io.modelcontextprotocol/protocolVersion"]`,
     *   4. `_meta["io.modelcontextprotocol/clientCapabilities"]`.
     *
     * Three of the four are the client's job. Ours is only to not lose them, and
     * the one way we could is `toWebRequest` — so that is asserted in
     * the wire-contract suite in the project's own gate, along with each requirement
     * proven by removing it.
     *
     * ⚠ THE FAILURE TO RECOGNISE. Strip `Mcp-Method` at the proxy and the answer
     * is `-32020`, "the body names method tools/list but the required Mcp-Method
     * header is absent" — a message that blames the client for a header it sent.
     * Legacy clients need none of the four and keep working throughout, so the
     * server looks healthy while every modern client fails. nginx forwards these
     * without configuration (they are hyphenated, so `underscores_in_headers`
     * does not apply), and nothing in this file may add them to a skip list.
     *
     * And the era is decided by the BODY envelope, not the header: a request
     * whose `_meta` names 2026-07-28 stays on the modern route even with no
     * version header at all, so a proxy that drops or rewrites that header
     * cannot quietly downgrade a modern client to legacy. It fails instead.
     * All measured 2026-09-13 against server@2.0.0. */
    const webRequest = toWebRequest(req, origin, body);
    let response: Response;
    try {
        response = await mcpHandler(version).fetch(webRequest, {
            authInfo: {
                token: cfg.credential,
                clientId: 'mcp-connector',
                scopes: ['vidofy.generate'],
                resource: new URL(`${origin}${MCP_PATH}`),
                extra: { cfg },
            },
        });
    } catch (err) {
        log(`mcp handler failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                jsonrpc: '2.0', error: { code: -32603, message: 'Request failed.' }, id: null,
            }));
        }
        return;
    }

    await sendWebResponse(res, response);
}

/**
 * Read the body with the ceiling enforced, or answer 413 and return null.
 *
 * v2's handler takes a Web `Request`, which needs the body up front — so the cap
 * that used to ride the stream while the old transport read it now has to be
 * applied HERE, before the Request is built. Same ceiling, same reason (measured:
 * an 80 MB POST took the process from 92 MB to 403 MB resident), enforced at the
 * only remaining place that sees the bytes arrive.
 *
 * The socket is destroyed rather than drained on overflow: draining a megabyte we
 * have already refused is doing the attacker's work for them.
 */
async function readBodyCapped(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
        for await (const chunk of req) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > MAX_BODY_BYTES) {
                log(`request body exceeded ${MAX_BODY_BYTES} bytes — refused`);
                if (!res.headersSent) {
                    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32600, message: `Request body may not exceed ${MAX_BODY_BYTES} bytes.` },
                        id: null,
                    }));
                }
                req.destroy();
                return null;
            }
            chunks.push(buf);
        }
    } catch {
        return null;        // the socket died; nothing to answer to
    }
    return Buffer.concat(chunks);
}

/** A Node request as the Web `Request` v2 expects. */
function toWebRequest(req: IncomingMessage, origin: string, body: Buffer): Request {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        /* Hop-by-hop and pseudo headers that a Web Request refuses or that would be
           wrong to forward. `host` in particular: the Request URL already carries
           the origin, and Headers rejects a second authority.
           ⚠ This is a SKIP list on purpose — never turn it into an allow-list, and
           never add an `mcp-` name to it. `Mcp-Method` is required on every modern
           request and `Mcp-Name` must agree with the body, so dropping either
           breaks all 2026-07-28 clients while legacy ones keep working. Both
           mistakes are caught by the wire-contract suite in the project's own gate. */
        if (k === 'connection' || k === 'host' || k === 'transfer-encoding' || k.startsWith(':')) continue;
        for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
    }
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
    return new Request(`${origin}${req.url ?? MCP_PATH}`, {
        method,
        headers,
        ...(hasBody ? { body } : {}),
        /* An abort signal wired to the socket, which is what makes cancellation
           work at all: v2 reads `request.signal` and surfaces it as
           `ctx.mcpReq.signal`, and that is the signal `generate` checks before it
           spends anything. Measured 2026-09-13 — a client disconnect aborts it
           immediately and v2 answers 499. Without this line the money guard added
           the same day would be a no-op that still reads correctly in the diff. */
        signal: abortOnSocketClose(req),
    });
}

/** An AbortSignal that fires when the client goes away. */
function abortOnSocketClose(req: IncomingMessage): AbortSignal {
    const ac = new AbortController();
    /* `aborted` fires when the client disconnects mid-request; `close` covers the
       socket ending for any other reason. Either way the caller is gone. Firing
       twice is harmless — abort() after abort() is a no-op. */
    req.once('aborted', () => ac.abort());
    req.once('close', () => ac.abort());
    return ac.signal;
}

/** Copy a Web `Response` onto the Node response. */
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
    if (res.headersSent) return;
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    res.writeHead(response.status, headers);
    if (response.body === null) {
        res.end();
        return;
    }
    /* Streamed rather than buffered: an SSE response has no end until the exchange
       does, so awaiting arrayBuffer() would hold it open and deliver nothing. */
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
                await new Promise((resolve) => res.once('drain', resolve));
            }
        }
    } catch {
        /* The client went away mid-stream. Nothing to report — the socket is gone
           and the tool handler's own signal has already been aborted. */
    } finally {
        res.end();
    }
}

function main(): void {
    const version = readVersion();
    const port = Number(process.env['VIDOFY_MCP_PORT'] ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        log(`VIDOFY_MCP_PORT must be a port number — got "${process.env['VIDOFY_MCP_PORT']}"`);
        process.exit(1);
    }

    /* Refuse to boot in production without a configured public origin.
     *
     * This is deliberately a crash and not a warning. Without the variable,
     * publicOrigin() used to fall back to the Host header, which means the issuer
     * in the authorization-server document and the audience bound into every
     * minted token were both whatever the last hop claimed. A warning in a log
     * nobody reads would have produced exactly what was measured: forged
     * discovery documents, or tokens that all fail later with the word
     * "audience". A process that will not start is a five-minute deploy problem;
     * the alternative is a week of unexplained refusals.
     *
     * Validated through resolveBaseUrl so the same rules that guard
     * VIDOFY_API_BASE guard this one: origin only, https except for local hosts,
     * no credentials, no path, no whitespace. */
    const declaredPublic = (process.env['VIDOFY_MCP_PUBLIC_URL'] ?? '').trim();
    if (declaredPublic === '') {
        if (!isLocalDevelopment()) {
            log('VIDOFY_MCP_PUBLIC_URL is required. Without it the issuer and the token '
                + 'audience would be taken from a request header, which the caller controls. '
                + `Set it to this connector's public origin (e.g. https://vidofy.ai).`);
            process.exit(1);
        }
        log('VIDOFY_MCP_PUBLIC_URL is unset — development run, origin will be read from '
            + 'the request headers. Never do this in production.');
    } else {
        try {
            const normalised = resolveBaseUrl({ VIDOFY_API_BASE: declaredPublic });
            log(`public origin: ${normalised}`);
        } catch (err) {
            log(`VIDOFY_MCP_PUBLIC_URL is not usable: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
    }

    const http = createServer((req, res) => {
        handle(req, res, version).catch((err: unknown) => {
            /* Never let a throw here hang the socket. The client would sit on an
               open connection with no answer, which reads as "Vidofy is down"
               rather than as one failed request. */
            log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'INTERNAL', message: 'Request failed.' }));
            } else {
                res.end();
            }
        });
    });

    /* 127.0.0.1, not 0.0.0.0 — nginx is the only thing that should reach this.
       Binding every interface would expose an unauthenticated-by-default port on
       whatever network the box sits on, and TLS terminates at nginx so traffic
       arriving here directly would be plaintext anyway. */
    http.listen(port, '127.0.0.1', () => {
        log(`remote MCP listening on http://127.0.0.1:${port}${MCP_PATH} — v${version}`);
        /* After listen, not before: the heartbeat claims this connector is
           serving, and until the socket is bound that claim is not yet true. */
        startHeartbeat();
    });
}

main();
