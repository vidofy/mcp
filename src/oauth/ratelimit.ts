/**
 * Rate limiting for the unauthenticated OAuth endpoints.
 *
 * WHY THIS EXISTS — what one request to /mcp-app/authorize actually costs:
 *
 *   • an outbound HTTPS request to a URL THE CALLER CHOSE (client_id is a URL and
 *     we fetch it), preceded by a DNS lookup, bounded at 2s and 8 KB
 *   • a socket and its buffers in the same process that serves every MCP tool
 *   • a Redis key that lives 600 seconds
 *
 * And it takes no credential at all. So a loop from one machine turns this server
 * into three different problems at once: our egress IP hammering a third party
 * who will rightly block us, a Node process out of sockets while real users wait
 * for a generation, and Redis filling with pending records nobody will redeem.
 *
 * WHO ACTUALLY CALLS /authorize, because it decides the shape of the limit:
 * the USER'S BROWSER, not the AI host's servers. That is not an inference from
 * the probe log — it is the authorization-code flow: the endpoint carries `state`
 * and ends at a consent screen the person has to read, which a server-to-server
 * caller cannot complete. The measured chain agrees (the discovery documents and
 * the first POST /mcp-app come from Anthropic's cloud; the authorize redirect does
 * not). So a per-IP bucket is a per-USER bucket here, and the shared-egress worry
 * that would make per-IP limiting wrong for a machine-to-machine endpoint does not
 * apply.
 *
 * A FIXED WINDOW, not a sliding one. It lets a caller spend the whole budget at
 * the end of one window and again at the start of the next — twice the nominal
 * rate across a window boundary — which is the known cost of the cheap algorithm
 * and is irrelevant at these limits. What it buys is an EXACT `Retry-After`:
 * seconds until this window resets, computed rather than guessed, which is what
 * the Partners API already does (see its Retry-After note). A sliding window
 * cannot answer that question honestly.
 */

import { redisClient } from './store.js';

/**
 * `cache:` — and the prefix differs from `mcp_oauth:` on purpose.
 *
 * The pending records deliberately avoid `cache:` because the admin "Clear cache"
 * button would destroy an authorization that exists nowhere else (see store.ts).
 * A rate-limit counter is the opposite: it is safe to lose. Clearing it just
 * refills everyone's budget, and the platform's own convention puts rate limits
 * under `cache:` for exactly that reason, stating the trade-off outright.
 * Kept visually distinct from the pending keys so nobody
 * reading a Redis dump mistakes one for the other.
 */
const PREFIX = 'cache:mcp:rl';

export interface RateVerdict {
    allowed: boolean;
    /** Seconds until the window resets. Exact, not advisory. */
    retryAfter: number;
    /** How many hits are in this window, including this one. */
    count: number;
}

/**
 * Count one hit against a bucket.
 *
 * @param bucket     Anything that identifies the caller for this limit, e.g.
 *                   `authorize:ip:1.2.3.4`. Hashed into the key as-is, so callers
 *                   must not put anything unbounded in it.
 * @param limit      Hits allowed per window.
 * @param windowSec  Window length.
 *
 * FAILS CLOSED on a Redis error, and that is deliberate rather than defensive
 * habit: every endpoint this guards needs Redis to do its job anyway — /authorize
 * cannot park a pending record without it — so a Redis outage means the request was
 * going to fail regardless. Refusing early with an honest message beats doing the
 * expensive outbound fetch first and failing after. The alternative, failing open,
 * would remove the limiter precisely when the system is least able to absorb a
 * flood.
 */
export async function hitLimit(bucket: string, limit: number, windowSec: number): Promise<RateVerdict> {
    const now = Math.floor(Date.now() / 1000);
    const windowIndex = Math.floor(now / windowSec);
    const retryAfter = (windowIndex + 1) * windowSec - now;
    const key = `${PREFIX}:${bucket}:${windowIndex}`;

    try {
        const client = await redisClient();
        const count = await client.incr(key);
        /* Expire only on the first hit. Re-setting it on every hit would turn the
           fixed window into a sliding one that never resets under sustained load,
           so a blocked caller could never recover. */
        if (count === 1) await client.expire(key, windowSec + 1);
        return { allowed: count <= limit, retryAfter, count };
    } catch {
        return { allowed: false, retryAfter: windowSec, count: -1 };
    }
}

/* ── the limits ──────────────────────────────────────────────────────────────
 *
 * Chosen against what a HUMAN does, then multiplied generously, because the cost
 * of being wrong is asymmetric: too loose still stops the flood, too tight locks a
 * real person out of connecting their account with no way to tell why.
 *
 * A person connecting a client does this ONCE. Twice if they make a mistake and
 * start again. Ten times in a minute is already someone testing; thirty is not a
 * person. An attacker needs thousands per minute for any of the three costs above
 * to matter.
 */

/** Starts of the flow, per IP. */
export const AUTHORIZE_PER_IP = { limit: 30, windowSec: 60 };

/**
 * Starts of the flow per client_id, across all IPs.
 *
 * The second layer, and the one that survives a distributed attacker: an attack
 * from a thousand addresses defeats a per-IP limit entirely, but every request
 * still has to name a client_id, and it is the client_id that drives the outbound
 * fetch this endpoint exists to protect. Deliberately much higher than the per-IP
 * limit — claude.ai is ONE client_id for every one of our users, so this bucket
 * must never be the thing that throttles legitimate traffic.
 *
 * It is not a complete answer on its own: an attacker rotating client_id values
 * gets a fresh bucket each time. What stops THAT is the concurrency cap on the
 * fetch itself, in clients.ts — a limit on how many outbound requests can be in
 * flight, which no amount of key rotation gets around.
 */
export const AUTHORIZE_PER_CLIENT = { limit: 600, windowSec: 60 };

/** The consent hand-off. Cheap (one Redis read) but not free, and unauthenticated. */
export const DECIDE_PER_IP = { limit: 60, windowSec: 60 };

/** The code exchange. One per completed flow; a flood here is guessing codes. */
export const TOKEN_PER_IP = { limit: 60, windowSec: 60 };
