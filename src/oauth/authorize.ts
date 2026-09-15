/**
 * `GET /mcp-app/authorize` — the protocol half of the authorization endpoint.
 *
 * It does everything that does not need to know who the user is: identify the
 * calling client, check what it asked for, park the request, and hand the
 * browser to the consent screen. Deciding is the user's half, and that lives at
 * /en/oauth/consent on the site itself, because the session cookie is
 * host-scoped to vidofy.ai by the site's session layer, and this process
 * cannot read it.
 *
 * TWO URLS, ONE FLOW — and they are named differently on purpose:
 *
 *   /mcp-app/authorize   machine-facing. What `authorization_endpoint` advertises.
 *   /en/oauth/consent    human-facing. Product-neutral, so the CLI or any later
 *                        client reaches the same screen (owner, 2026-09-12).
 *
 * Calling both "authorize" was the first draft and would have cost somebody an
 * hour six months from now.
 *
 * THE ERROR RULE THAT MATTERS
 * ---------------------------
 * OAuth 2.1 splits failures in two, and the split is a security boundary rather
 * than a style:
 *
 *   • client_id or redirect_uri is bad  → answer HERE, never redirect. Redirecting
 *     to a URI we have not validated IS the open redirect.
 *   • anything else is wrong            → redirect to the VALIDATED redirect_uri
 *     with `error` and `state`, because the client is waiting there and a page
 *     served by us is a dead end it cannot recover from.
 */

import type { ServerResponse } from 'node:http';

import { fetchClientMetadata, redirectUriAllowed, ClientError } from './clients.js';
import { savePending, readPending, consumePending, issueCode } from './store.js';
import { resolveBaseUrl } from '../config.js';

/** Where the human decides. Product-neutral — see the header. */
const CONSENT_PATH = '/en/oauth/consent';

/**
 * The only scope this server grants, as the client sees it.
 *
 * It must stay the name advertised in `scopes_supported` in the
 * authorization-server document (http.ts) and in the 401's `scope` parameter —
 * three places, one string. The credential's INTERNAL scope is a different name
 * because that one is what the server enforces per endpoint; they are
 * deliberately not the same value and neither is derived from the other.
 */
const GRANTED_SCOPE = 'vidofy.generate';

/** Fail before the redirect_uri is trusted: answer directly. */
function failHere(res: ServerResponse, status: number, error: string, description: string): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error, error_description: description }, null, 2));
}

/** Fail after it is trusted: send the client its error, with state intact. */
function failToClient(
    res: ServerResponse,
    redirectUri: string,
    error: string,
    description: string,
    state: string | null
): void {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state !== null) u.searchParams.set('state', state);
    res.writeHead(302, { location: u.href });
    res.end();
}

/**
 * @param canonicalResource This server's own resource identifier — the value
 *        both hosts send as `resource`. A request naming anything else is asking
 *        us to mint a token for an audience we do not serve.
 */
export async function handleAuthorize(
    res: ServerResponse,
    url: URL,
    canonicalResource: string,
    opts: { allowPrivateClients?: boolean } = {}
): Promise<void> {
    const q = url.searchParams;
    const get = (k: string): string | null => {
        const v = q.get(k);
        return v === null || v.trim() === '' ? null : v.trim();
    };

    const clientId = get('client_id');
    const redirectUri = get('redirect_uri');
    const state = get('state');

    if (clientId === null) {
        failHere(res, 400, 'invalid_request', 'client_id is required.');
        return;
    }
    if (redirectUri === null) {
        failHere(res, 400, 'invalid_request', 'redirect_uri is required.');
        return;
    }

    /* Identify the client from its own metadata document, and only then trust
       the redirect_uri it sent. Both checks must pass before a single redirect
       happens — that ordering is the whole protection. */
    let client;
    try {
        client = await fetchClientMetadata(clientId, {
            ...(opts.allowPrivateClients === true ? { allowPrivate: true } : {}),
        });
    } catch (err) {
        failHere(res, 400, 'invalid_client',
            err instanceof ClientError ? err.message : 'client_id could not be resolved.');
        return;
    }
    if (!redirectUriAllowed(client, redirectUri)) {
        failHere(res, 400, 'invalid_request',
            'redirect_uri is not listed in the client_id document.');
        return;
    }

    // ── From here the redirect_uri is trusted, so errors go back to the client ──

    if (get('response_type') !== 'code') {
        failToClient(res, redirectUri, 'unsupported_response_type',
            'Only response_type=code is supported.', state);
        return;
    }

    /* PKCE is mandatory in OAuth 2.1 and we advertise S256 alone. `plain` exists
       in the RFC for clients that cannot hash; no MCP client is one, and
       accepting it would mean a challenge an eavesdropper can replay. */
    const codeChallenge = get('code_challenge');
    if (codeChallenge === null) {
        failToClient(res, redirectUri, 'invalid_request', 'code_challenge is required.', state);
        return;
    }
    if (get('code_challenge_method') !== 'S256') {
        failToClient(res, redirectUri, 'invalid_request',
            'code_challenge_method must be S256.', state);
        return;
    }

    /* RFC 8707. Measured 2026-09-12: claude.ai and ChatGPT BOTH send it, so this
       is the live path and not a defensive branch. The token we eventually issue
       is bound to this value; a request naming another resource is asking for a
       token we must not mint, and `invalid_target` is the RFC's own code for it.
       Absent is tolerated — the spec puts the MUST on clients, and refusing a
       compliant-enough client would break it for no gain when we bind to our own
       resource anyway. */
    const resource = get('resource');
    if (resource !== null && resource !== canonicalResource) {
        failToClient(res, redirectUri, 'invalid_target',
            'resource does not identify this server.', state);
        return;
    }

    const id = await savePending({
        clientId,
        clientName: client.clientName,
        redirectUri,
        codeChallenge,
        resource: canonicalResource,
        /* The GRANTED scope, fixed — not the requested one.
         *
         * This used to be `get('scope') ?? 'vidofy.generate'`, so whatever string
         * the client asked for was stored and then echoed back from /token as
         * though it had been granted. It never was: the server mints exactly
         * one scope (`generate_read`, its default) and the router enforces
         * that and nothing else. A client asking for `admin` would have been told
         * `admin` and given `generate_read` — a lie in a protocol field clients are
         * entitled to believe.
         *
         * When more than one scope exists, the requested value gets intersected
         * with what we are willing to grant HERE, and the result is what is stored.
         * Until then there is one answer and this is it. */
        scope: GRANTED_SCOPE,
        state,
        // ChatGPT sends ui_locales=en-US, Claude sends none. Carried through so
        // the consent screen can honour it; nothing reads it yet.
        uiLocales: get('ui_locales'),
    });

    /* The consent screen lives on the SITE, not here — a different origin in
       development and the same one in production. Built from
       VIDOFY_API_BASE through the same validator the credential path uses, so a
       hostile value cannot send the user somewhere else. */
    const consent = new URL(CONSENT_PATH, resolveBaseUrl());
    consent.searchParams.set('request', id);
    res.writeHead(302, { location: consent.href });
    res.end();
}

/**
 * `GET /mcp-app/authorize/decide?request=<id>` — the browser coming back from
 * the consent page.
 *
 * Turns a recorded decision into the OAuth response the waiting client expects:
 * a code, or `access_denied`.
 *
 * WHAT IT TRUSTS, AND WHY
 * -----------------------
 * Everything comes from the stored record; nothing from this request except the
 * id. In particular the redirect_uri is the one /authorize validated against the
 * client's metadata document minutes ago — reading it from the query here would
 * undo that check and hand anyone with a request id a code sent wherever they
 * like.
 *
 * The approving user's identity comes from the record too, written by the
 * site's consent page after it authenticated the session. This process
 * cannot verify a session cookie (host-scoped to the site), so the trust
 * boundary is Redis itself: only the site and this connector can write those
 * keys, and Redis is not reachable from outside the host.
 */
export async function handleAuthorizeDecide(res: ServerResponse, url: URL): Promise<void> {
    const id = url.searchParams.get('request');
    if (id === null || id.trim() === '') {
        failHere(res, 400, 'invalid_request', 'request is required.');
        return;
    }

    /* READ first. Only a DECIDED record is consumed.
     *
     * ⚠ THIS USED TO CONSUME UNCONDITIONALLY, and the comment that stood here
     * defended it — "one consent is worth exactly one code" — which is true and
     * was not the whole story. GETDEL ran before anything checked whether a
     * decision existed, so a hit on this URL with an id and NO approval deleted
     * the pending record and the old comment shrugged: "the record is already
     * gone". That is a denial of service on somebody else's sign-in. The id is
     * not guessable (32 random bytes) but it is not secret either — it sits in
     * the address bar of the consent page, so it is in browser history, in a
     * screen share, in a pasted URL. One request, and the user who then clicks
     * Allow is told their request expired, with nothing anywhere explaining why.
     *
     * Found by test/oauth_flow.test.mjs on its first run — this endpoint had no
     * test at all until then.
     *
     * The single-use property is kept exactly: an undecided record is only read,
     * and a decided one is taken with GETDEL, so two concurrent hits after an
     * approval still produce one code. Consuming late does not weaken that; it
     * only stops the undecided case from being destructive. */
    const peek = await readPending(id.trim());
    if (peek === null) {
        failHere(res, 400, 'invalid_request',
            'This authorization request has expired or was already completed.');
        return;
    }
    if (peek.decision === undefined) {
        /* Nobody approved anything: someone reached this URL without passing
           through the consent page. The record is LEFT ALONE so the real flow can
           still finish. Answered here rather than redirected — the client is not
           owed a response to a flow its user never completed. */
        failHere(res, 400, 'access_denied', 'This request was not approved.');
        return;
    }

    const pending = await consumePending(id.trim());
    if (pending === null) {
        /* Lost the race against a concurrent decide, or it expired in the
           microseconds between the two calls. Either way exactly one caller got
           it, which is the property that matters. */
        failHere(res, 400, 'invalid_request',
            'This authorization request has expired or was already completed.');
        return;
    }
    if (pending.decision === undefined) {
        // Cannot happen — the peek above saw one. Fail closed rather than assume.
        failHere(res, 400, 'access_denied', 'This request was not approved.');
        return;
    }

    /* An approval with no token is an approval we cannot honour: the consent
       page refuses to record one, so reaching here means the record was
       tampered with or written by an older build. Treated as a denial rather
       than issuing a code /token could never fulfil — the client would otherwise
       show success and then fail. */
    const rawToken = typeof pending.rawToken === 'string' && pending.rawToken.startsWith('vmt_')
        ? pending.rawToken
        : null;
    if (pending.decision === 'allow' && rawToken === null) {
        failToClient(res, pending.redirectUri, 'server_error',
            'The access token could not be prepared.', pending.state);
        return;
    }

    if (pending.decision !== 'allow' || rawToken === null
        || typeof pending.userId !== 'number' || pending.userId <= 0) {
        /* A refusal is a normal OAuth outcome, not an error page: the client is
           waiting at its redirect_uri and can tell the user plainly. */
        failToClient(res, pending.redirectUri, 'access_denied',
            'The user declined the request.', pending.state);
        return;
    }

    const code = await issueCode({
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        scope: pending.scope,
        userId: pending.userId,
        rawToken,
        tokenRowId: pending.tokenRowId ?? 0,
    });

    const back = new URL(pending.redirectUri);
    back.searchParams.set('code', code);
    /* Echoed byte for byte when present, and omitted entirely when not. `state`
       is the client's own CSRF protection for this flow; altering or inventing
       one breaks the check it exists for. */
    if (pending.state !== null) back.searchParams.set('state', pending.state);
    res.writeHead(302, { location: back.href });
    res.end();
}
