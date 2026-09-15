/**
 * `POST /mcp-app/token` — the authorization code becomes an access token.
 *
 * This is the only place a credential leaves the server, so everything it checks
 * is a precondition for handing one over:
 *
 *   1. the code exists and has not been used   (GETDEL — one code, one token)
 *   2. the client asking is the client the code was issued to
 *   3. the redirect_uri matches the one bound to the code
 *   4. PKCE: SHA256(code_verifier) equals the challenge recorded at /authorize
 *
 * PKCE IS THE WHOLE PROTECTION HERE
 * ---------------------------------
 * The code travels through the user's browser — in a URL, through history, past
 * whatever extensions are installed. Anyone who captures it could exchange it,
 * and the client authenticates with `none` (a public client has no secret to
 * prove itself with). What stops the exchange is that the thief does not have
 * the verifier: it never left the client. So this check is not defence in depth,
 * it is the door.
 *
 * WHY THERE IS NO TOKEN GENERATION IN THIS FILE
 * ---------------------------------------------
 * The `vmt_` token was minted by the site when the user approved, and rides in
 * the code record. The site owns the credential format, the hash, the scope and
 * the expiry; a second implementation here would be a second definition of one
 * credential.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

import { consumeCode } from './store.js';

/** Read a urlencoded body, capped — a token request is a few hundred bytes. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    const MAX = 8 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const b = chunk as Buffer;
        size += b.length;
        if (size > MAX) throw new Error('body too large');
        chunks.push(b);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function fail(res: ServerResponse, status: number, error: string, description: string): void {
    /* RFC 6749 §5.2: the token endpoint's errors are JSON with no-store, and the
       status matters — a client distinguishes "your code is bad" (400) from
       "come back later". */
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        pragma: 'no-cache',
    });
    res.end(JSON.stringify({ error, error_description: description }));
}

/** Constant-time compare of two base64url strings, safe on length mismatch. */
function sameSecret(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    /* timingSafeEqual throws when the lengths differ, and returning early on
       that is fine: the length of a PKCE challenge is not the secret. */
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

export async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
        fail(res, 405, 'invalid_request', 'The token endpoint accepts POST.');
        return;
    }

    let form: URLSearchParams;
    try {
        form = await readForm(req);
    } catch {
        fail(res, 400, 'invalid_request', 'Request body could not be read.');
        return;
    }

    const get = (k: string): string => (form.get(k) ?? '').trim();

    if (get('grant_type') !== 'authorization_code') {
        /* The RFC's own code for this, and the reason we advertise only
           authorization_code: there is no refresh token to grant. */
        fail(res, 400, 'unsupported_grant_type',
            'Only grant_type=authorization_code is supported.');
        return;
    }

    const code = get('code');
    const verifier = get('code_verifier');
    const clientId = get('client_id');
    const redirectUri = get('redirect_uri');

    if (code === '' || verifier === '') {
        fail(res, 400, 'invalid_request', 'code and code_verifier are required.');
        return;
    }

    /* Consumed before anything is validated, deliberately.
     *
     * A code that fails any check below is burned either way — OAuth 2.1 says a
     * code must not be reusable, and a failed attempt is the clearest sign it
     * may have been stolen. Validating first and deleting after would leave a
     * stolen code alive for as many guesses as the attacker wants. */
    const issued = await consumeCode(code);
    if (issued === null) {
        fail(res, 400, 'invalid_grant', 'The authorization code is invalid or expired.');
        return;
    }

    /* The client must be the one the code belongs to, and the redirect_uri must be
     * the one the code was bound to. Since these are public clients with no
     * secret, client_id is all there is to compare.
     *
     * ⚠ BOTH CHECKS USED TO BE OPTIONAL, and the comments that stood here stated
     * the requirement while the code declined to enforce it: they read
     * `clientId !== '' && clientId !== issued.clientId`, so a token request that
     * simply OMITTED client_id and redirect_uri skipped both. RFC 6749 §4.1.3
     * makes client_id REQUIRED for a public client precisely so a code cannot be
     * redeemed by whoever holds it.
     *
     * That permissive branch served no case anyone could name — the measured
     * clients (claude.ai and ChatGPT) both send client_id, and the project's rule
     * is that a lenient branch must prove the case it exists for or fail closed.
     * It now fails closed. */
    if (clientId === '') {
        fail(res, 400, 'invalid_request', 'client_id is required.');
        return;
    }
    if (clientId !== issued.clientId) {
        fail(res, 400, 'invalid_grant', 'The code was not issued to this client.');
        return;
    }
    if (redirectUri === '') {
        fail(res, 400, 'invalid_request', 'redirect_uri is required.');
        return;
    }
    if (redirectUri !== issued.redirectUri) {
        fail(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
        return;
    }

    /* PKCE S256: BASE64URL(SHA256(ASCII(verifier))) must equal the challenge. */
    const computed = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (!sameSecret(computed, issued.codeChallenge)) {
        fail(res, 400, 'invalid_grant', 'code_verifier does not match the challenge.');
        return;
    }

    /* ── Everything checked. Hand over the token. ────────────────────────────
     *
     * No `refresh_token`, by decision and with the spec's blessing: "MCP Clients
     * MUST NOT assume refresh tokens will be issued; the AS retains discretion".
     * The access token is long-lived instead, and `expires_in` says so honestly
     * rather than implying forever.
     *
     * One year, matching the expiry the site stamped on the row. The two are
     * written in two places and that is a drift risk worth naming: if the
     * site's '+1 year' changes, this number must change with it. */
    const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

    res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // Required by RFC 6749 §5.1 — a cached token response is a leaked token.
        'cache-control': 'no-store',
        pragma: 'no-cache',
    });
    res.end(JSON.stringify({
        access_token: issued.rawToken,
        token_type: 'Bearer',
        expires_in: ONE_YEAR_SECONDS,
        scope: issued.scope,
    }));
}
