/**
 * The state an authorization flow leaves behind between requests.
 *
 * Two short-lived records, both in Redis:
 *
 *   pending   /authorize → the consent page → back        (the user has not decided yet)
 *   code      the redirect to the client → /token          (a one-time authorization code)
 *
 * WHY REDIS AND NOT THIS PROCESS'S MEMORY
 * ---------------------------------------
 * Owner decision 2026-09-12, and it buys two things memory cannot:
 *
 *   1. It survives a restart. A Map would mean every deploy cancels whoever is
 *      mid-sign-in, and they would see a failure with no cause.
 *   2. PHP can read and write it. The consent screen lives on vidofy.ai because
 *      that is where the session cookie is — so approval is recorded by a
 *      different language in a different process. Shared storage is what lets
 *      that happen without inventing a signed side-channel between them.
 *
 * It is also how the rest of the project already works, which matters more than
 * elegance: one place to look when something is stuck.
 *
 * KEY NAMING — deliberately NOT under `cache:`
 * --------------------------------------------
 * The platform's convention is that every cache key starts with `cache:` so an
 * operator's "Clear cache" action can wipe them with one SCAN. These keys must
 * NOT carry that prefix, for the same reason the platform exempts its other
 * write-once secrets. They are not a copy of anything. A pending
 * authorization exists ONLY here, and an authorization code is a single-use
 * secret with no source to rebuild it from. An admin pressing Clear Cache while
 * someone is signing in would destroy it, and the user would be bounced back to
 * their client with an error nobody could explain.
 *
 * So: `mcp_oauth:pending:<id>` and `mcp_oauth:code:<code>`, alongside
 * `mcp_flash:` which is there for the same reason.
 *
 * ⚠ AND THAT PROTECTS THESE KEYS FROM *ONE* ACTION, NOT FROM AN OPERATOR. There
 * is a second, coarser one that flushes Redis outright. That erases every
 * database, so it takes `mcp_oauth:` with it along with every session — which is
 * why its own confirmation warns that all users are signed out. The paragraph
 * above is about the prefix-scoped clear and was true of it; read alone it
 * implied a safety these keys do not have.
 *
 * The consequence is small and worth stating so nobody hunts it: an admin
 * pressing that button during someone's consent flow ends that flow with an
 * error, and the user starts again. A ten-minute window, not a lost credential.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type RedisClientType } from 'redis';

/** How long a user has to finish the consent screen. */
const PENDING_TTL_SEC = 600;

/**
 * How long the client has to exchange the code.
 *
 * OAuth 2.1 says a code SHOULD be short-lived and single-use, and recommends a
 * maximum of 10 minutes; 60 seconds is enough for a redirect and one POST, and
 * every second beyond that is a window for a leaked code to be replayed.
 */
const CODE_TTL_SEC = 60;

const PREFIX = 'mcp_oauth';

/** An authorization request, parked while the user decides. */
export interface PendingAuthorization {
    clientId: string;
    clientName: string;
    redirectUri: string;
    codeChallenge: string;
    /** The resource the token will be bound to — RFC 8707, sent by both hosts. */
    resource: string;
    scope: string;
    /** Echoed back to the client untouched; absent when the client sent none. */
    state: string | null;
    /** Consent-screen language hint. ChatGPT sends it, Claude does not. */
    uiLocales: string | null;
    createdAt: number;

    /* ── written by the consent page, not by /authorize ──────────────────────
     *
     * The site's consent page fills these in after the user decides, then sends
     * the browser to /mcp-app/authorize/decide. Absent means nobody has decided
     * yet, which is how a request reaching `decide` without consent is told
     * apart from an approved one — and why `decision` is optional here rather
     * than defaulted to anything. */
    decision?: 'allow' | 'deny';
    /** The approving account. 0 on deny. */
    userId?: number;
    decidedAt?: number;
    /** The minted `vmt_` token — see IssuedCode.rawToken. Present only on allow. */
    rawToken?: string;
    tokenRowId?: number;
}

/** An issued authorization code, waiting to be exchanged exactly once. */
export interface IssuedCode {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
    /** Who approved it. The whole point of the flow. */
    userId: number;
    /**
     * The `vmt_` token itself, minted by PHP at consent time.
     *
     * It travels here rather than being created at /token because
     * The site owns the credential format and the row, and a second
     * implementation in TypeScript would be a second definition of one
     * credential. Same pattern as `mcp_flash:` on the tokens page.
     * Lives at most CODE_TTL_SEC, and the
     * record is destroyed by GETDEL the moment it is exchanged.
     */
    rawToken: string;
    /** The row id, so a failed exchange can be traced back to what was created. */
    tokenRowId: number;
}

let client: RedisClientType | null = null;

/**
 * The shared connection, opened on first use.
 *
 * `redis` reconnects on its own; what it does NOT do is queue commands forever
 * while down, so a caller still has to handle a rejection — see the note on
 * readPending.
 */
/**
 * The site's `.env`, parsed once — or an empty object when there is none.
 *
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding quotes.
 * It is not a dotenv replacement and must not become one; the site's own parser
 * is the authority on this file's format, and anything it supports that this
 * does not is a reason to pass the value through the real environment instead.
 *
 * Found by walking UP from this module rather than from `process.cwd()`, because
 * the working directory depends on who started the process — a manager, a shell
 * in `vidofy-mcp/`, or a shell in the repo root — while the module's own position
 * relative to the repo never changes. `VIDOFY_ENV_FILE` overrides it outright for
 * a deployment that puts the file somewhere else.
 */
let cachedFileEnv: Record<string, string> | null = null;
function siteEnvFile(): Record<string, string> {
    if (cachedFileEnv !== null) return cachedFileEnv;
    cachedFileEnv = {};

    const explicit = (process.env['VIDOFY_ENV_FILE'] ?? '').trim();
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/oauth → dist → vidofy-mcp → repo root. Four, to survive src/ vs dist/.
    const candidates = explicit !== ''
        ? [explicit]
        : [1, 2, 3, 4].map((up) => join(here, ...Array(up).fill('..'), '.env'));

    for (const path of candidates) {
        let text: string;
        try {
            text = readFileSync(path, 'utf8');
        } catch {
            continue;           // absent is normal — the npm package has no .env
        }
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                v = v.slice(1, -1);
            }
            cachedFileEnv[k] = v;
        }
        break;
    }
    return cachedFileEnv;
}

/**
 * The same connection, for code in this folder that is not about pending records.
 *
 * Exported for the rate limiter, which needs Redis and must not open a second
 * connection to get it: two clients means two reconnect loops, two error handlers
 * and twice the file descriptors, for one process that already has one working
 * client. The `.env` reading and the NOAUTH problem below are also things a second
 * connection would have to get right a second time.
 */
export async function redisClient(): Promise<RedisClientType> {
    return await redis();
}

async function redis(): Promise<RedisClientType> {
    if (client !== null && client.isOpen) return client;

    /* Where the connection details come from, in order: the process environment
     * under `VIDOFY_REDIS_*`, then under the site's own `REDIS_*`, then the site's
     * `.env` FILE.
     *
     * That third source is the one that matters, and it was missing. Only the
     * `VIDOFY_`-prefixed variables were read, and they appear in no deploy artifact
     * anywhere — no process-manager config, no unit file, not `.env`. The
     * first fix for that read `REDIS_*` too, which looked right and was still
     * incomplete: **Node does not read `.env`.** That file is parsed by the
     * site's own loader, so `process.env.REDIS_PASSWORD` is empty unless a
     * human happened to export it in the shell that started this process.
     *
     * And it is not a production-only problem, which is what the first version of
     * this comment assumed. Measured 2026-09-13: local Redis answers
     * `NOAUTH Authentication required` without a password. So with none of these
     * variables exported, every call here fails — locally too — and /authorize
     * answers a bare 500 with no explanation.
     *
     * Reading the file is done here rather than by adding dotenv: one dependency
     * for fifteen lines, on a package that also ships to npm as a standalone stdio
     * server where the file does not exist and Redis is never used at all. Absent
     * is therefore silent, not an error. */
    const fileEnv = siteEnvFile();
    const env = (a: string, b: string, fallback: string): string => {
        const first = (process.env[a] ?? '').trim();
        if (first !== '') return first;
        const second = (process.env[b] ?? '').trim();
        if (second !== '') return second;
        return (fileEnv[b] ?? '').trim() || fallback;
    };
    const host = env('VIDOFY_REDIS_HOST', 'REDIS_HOST', '127.0.0.1');
    const port = Number(env('VIDOFY_REDIS_PORT', 'REDIS_PORT', '6379'));
    const password = env('VIDOFY_REDIS_PASSWORD', 'REDIS_PASSWORD', '');
    /* The same logical database the site uses. Sharing it is intentional: the
       site reads these keys, and a different database would mean the consent
       page writing where this process never looks. */
    const database = Number(env('VIDOFY_REDIS_DB', 'REDIS_DB', '1'));

    const c: RedisClientType = createClient({
        socket: { host, port },
        ...(password !== '' ? { password } : {}),
        database,
    });
    /* Without a listener, an error event on a node-redis client is an unhandled
       'error' and takes the process down — which would turn a Redis blip into an
       outage of every tool, not just the ones that need storage. */
    c.on('error', () => { /* surfaced by the awaiting caller instead */ });
    await c.connect();
    client = c;
    return c;
}

/** 32 bytes of URL-safe randomness — the id and code format. */
function token(): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(32)))
        .toString('base64url');
}

/* ── pending authorizations ───────────────────────────────────────────────── */

export async function savePending(p: Omit<PendingAuthorization, 'createdAt'>): Promise<string> {
    const id = token();
    const c = await redis();
    await c.set(`${PREFIX}:pending:${id}`, JSON.stringify({ ...p, createdAt: Date.now() }), {
        expiration: { type: 'EX', value: PENDING_TTL_SEC },
    });
    return id;
}

/**
 * Read a parked request.
 *
 * Returns null when it is missing OR expired — the two are indistinguishable and
 * should be: the caller's answer is the same, and telling a caller which one it
 * was lets them probe for ids that exist.
 */
export async function readPending(id: string): Promise<PendingAuthorization | null> {
    const raw = await (await redis()).get(`${PREFIX}:pending:${id}`);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as PendingAuthorization;
    } catch {
        return null;
    }
}

export async function deletePending(id: string): Promise<void> {
    await (await redis()).del(`${PREFIX}:pending:${id}`);
}

/**
 * Read a parked request and destroy it in ONE step.
 *
 * The same GETDEL reasoning as consumeCode, for the same reason: an approved
 * request is worth exactly one authorization code. With a read followed by a
 * delete, two simultaneous hits on /authorize/decide both see the approval
 * before either removes it, and two codes come out of one consent — which
 * multiplies a single "Allow" into more grants than the user agreed to.
 */
export async function consumePending(id: string): Promise<PendingAuthorization | null> {
    const raw = await (await redis()).getDel(`${PREFIX}:pending:${id}`);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as PendingAuthorization;
    } catch {
        return null;
    }
}

/* ── authorization codes ──────────────────────────────────────────────────── */

export async function issueCode(data: IssuedCode): Promise<string> {
    const code = token();
    await (await redis()).set(`${PREFIX}:code:${code}`, JSON.stringify(data), {
        expiration: { type: 'EX', value: CODE_TTL_SEC },
    });
    return code;
}

/**
 * Consume a code — read it and destroy it in ONE atomic step.
 *
 * GETDEL, not GET-then-DEL. With two commands, two simultaneous exchanges of the
 * same stolen code both read it before either deletes it, and both get a token:
 * the single-use rule becomes a race. OAuth 2.1 requires the code be usable once,
 * and this is where that is enforced.
 */
export async function consumeCode(code: string): Promise<IssuedCode | null> {
    const raw = await (await redis()).getDel(`${PREFIX}:code:${code}`);
    if (raw === null) return null;
    try {
        return JSON.parse(raw) as IssuedCode;
    } catch {
        return null;
    }
}

/** Close the connection — for tests and a clean shutdown. */
export async function closeStore(): Promise<void> {
    if (client !== null && client.isOpen) await client.quit();
    client = null;
}
