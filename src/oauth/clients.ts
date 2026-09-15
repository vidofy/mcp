/**
 * Who is asking — OAuth client identification by Client ID Metadata Document.
 *
 * An MCP client tells us who it is by putting a URL in `client_id` and hosting
 * its own OAuth metadata there (draft-ietf-oauth-client-id-metadata-document).
 * We fetch that URL and read the client's name and its permitted redirect_uris.
 *
 * WHY ONLY THIS MECHANISM
 * -----------------------
 * The spec offers three (Client ID Metadata Documents, pre-registration,
 * Dynamic Client Registration) and calls DCR "deprecated, retained for backwards
 * compatibility". We did not take that on faith: the connector advertised BOTH
 * `registration_endpoint` and `client_id_metadata_document_supported` and logged
 * what real hosts chose (2026-09-12, through a cloudflared tunnel):
 *
 *   claude.ai  client_id = https://claude.ai/oauth/mcp-oauth-client-metadata
 *   ChatGPT    client_id = https://chatgpt.com/oauth/<per-connector>/client.json
 *   requests to /register = ZERO, from either
 *
 * So DCR is not implemented and `registration_endpoint` is not advertised. When
 * a client appears that needs it, the log will show the call and we will know.
 *
 * ⚠ THIS FETCHES A URL THE CALLER CHOSE
 * -------------------------------------
 * `client_id` is attacker-controlled by definition — anyone can start an
 * authorization request. ChatGPT's is per-connector and unguessable, so we
 * cannot allow-list known URLs; the document really is arbitrary. That makes
 * this a server-side request forgery surface: point `client_id` at
 * http://169.254.169.254/ or http://127.0.0.1:6379/ and the fetch becomes a
 * probe of our own network.
 *
 * The guards below mirror the same rules the site already applies to partner
 * callback URLs, rather than inventing a second policy. They are reimplemented
 * rather than called because the site's copy is PHP; where the two could drift,
 * the site is the reference.
 */

import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import { log } from '../log.js';

/** What the authorization flow needs to know about the caller. */
export interface ClientInfo {
    /** The URL that identifies it — echoed back as client_id. */
    clientId: string;
    /** Display name for the consent screen. Falls back to the host. */
    clientName: string;
    /** Every redirect_uri the client says it may use. */
    redirectUris: string[];
    /** For the consent screen's "this is who is asking" line. */
    clientUri: string | null;
    logoUri: string | null;
}

export class ClientError extends Error {}

/**
 * A refusal whose REASON must not reach the caller.
 *
 * The split it marks is the whole of the oracle fix, so it is worth stating as a
 * rule rather than a habit:
 *
 *   ClientError        — decided from the caller's own string, with no network
 *                        touched: not a URL, not https, has credentials, has a
 *                        fragment, port not allowed. The caller already knows their
 *                        own URL, so saying why tells them nothing they did not
 *                        have, and it is exactly what a client developer needs.
 *
 *   OpaqueClientError  — decided by what happened when we reached out to a host the
 *                        CALLER CHOSE: the address rules, the connection, the
 *                        status, the size, whether the body parsed, whether the
 *                        document declared what it must.
 *
 * Why the second group must be silent, and why that does not cost a legitimate
 * developer anything: every one of those answers is already available to whoever
 * owns the host. Their access log shows our request and their own response; their
 * document is in their hands. They do not need us to tell them it returned 500.
 *
 * An attacker probing an internal address has none of that — which is precisely
 * what made our message valuable to them. `document returned 403` versus
 * `is not a JSON object` versus `could not be fetched`, over a range of addresses,
 * is a port scanner with our egress IP and no credential.
 *
 * The real reason is logged on our side, always. Nothing is lost, it just stops
 * being answered to a stranger.
 */
export class OpaqueClientError extends ClientError {}

/** The single sentence every OpaqueClientError becomes on the way out. */
const OPAQUE_MESSAGE =
    'The client_id document could not be used. Check that the URL serves a valid '
    + 'Client ID Metadata Document over https — your own server log will show our request.';

/** Standard HTTP(S) ports only — same list as the site's own URL validator. */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/** 8 KB is generous for a document of seven fields; anything larger is not one. */
const MAX_BYTES = 8 * 1024;

/** Matches the site's token-name cap, since the site stores this value. */
const MAX_CLIENT_NAME = 60;

/**
 * How long a SUCCESSFUL document is reused, and how many are kept.
 *
 * This is the cheapest of the three defences on this endpoint and the only one
 * that makes legitimate traffic cost less rather than merely refusing abuse:
 * measured on the real hosts, there are TWO client_id values in the world that
 * matter — one URL for claude.ai and one per connector for ChatGPT — so every
 * user of ours who connects is fetching the same document. Caching it means a
 * thousand real sign-ins in five minutes cost one outbound request.
 *
 * Only successes are cached. Caching a failure would let one transient blip lock
 * a legitimate client out for the whole TTL, turning a 500ms hiccup into five
 * minutes of "client_id could not be resolved" — and it would gain nothing
 * against an attacker, who is sending DIFFERENT urls rather than repeating one.
 *
 * In-process rather than Redis, deliberately: one process serves this, the values
 * are public metadata with nothing to protect, and a Redis round trip per lookup
 * would trade the network call we are avoiding for a smaller network call.
 *
 * The size cap is the part that matters for abuse: without it, an attacker naming
 * a fresh url each time would grow this map without limit, which is a memory leak
 * with a helpful name. 64 entries is far above the handful that exist for real.
 */
const DOC_CACHE_TTL_MS = 5 * 60 * 1000;
const DOC_CACHE_MAX = 64;
const docCache = new Map<string, { info: ClientInfo; expiresAt: number }>();

/**
 * How many CIMD fetches may be in flight at once, across every caller.
 *
 * The rate limits in ratelimit.ts are keyed on the caller's IP and on client_id,
 * and each has a hole the other covers — except one: an attacker spread across
 * many addresses AND rotating client_id gets a fresh bucket every time. This is
 * what closes it, because it does not care who is asking. Six concurrent outbound
 * requests is the ceiling regardless of how the traffic is shaped.
 *
 * Refused immediately rather than queued. A queue holds the sockets and the memory
 * this exists to bound, and it converts a flood into latency for everyone instead
 * of a clear refusal for the flood. With the cache above, a legitimate user rarely
 * reaches the network at all, so being refused here means an attack is in progress
 * — and their client will start the flow again.
 */
const MAX_CONCURRENT_FETCHES = 6;
let inFlight = 0;

/**
 * A fetch that hangs is a denial of service on the authorize endpoint.
 *
 * Lowered from 5s to 2s on 2026-09-13 so the timing floor below can cover it — see
 * there for why the two numbers are related. 2s is generous for a document of
 * seven fields: a host that cannot serve 300 bytes of JSON in two seconds is not
 * one we should be waiting on while a person watches a sign-in screen.
 */
const TIMEOUT_MS = 2_000;

/**
 * Every OPAQUE refusal takes at least this long. The words alone were not enough.
 *
 * ⚠ THE MESSAGES WERE MERGED AND THE CLOCK STILL TOLD THEM APART. Measured
 * 2026-09-12: a blocked address refuses in ~0 ms because no network is touched,
 * while an unknown host takes ~52 ms waiting for DNS — and both answer the
 * identical sentence "client_id host could not be used". A host that exists and
 * answers takes a few hundred. So the four outcomes an attacker wants to
 * distinguish were distinguishable by stopwatch, and merging the text moved the
 * channel rather than closing it.
 *
 * WHY THIS NUMBER IS ABOVE TIMEOUT_MS, and not equal to it. If the floor were
 * lower, a timeout would be the one refusal that takes longer than the rest and so
 * the one still identifiable — "this host exists but is silent" is exactly the
 * answer a port scan wants. Padding every opaque refusal past the timeout collapses
 * them all, timeout included, onto one duration.
 *
 * NO JITTER, deliberately, although it feels like the more cautious choice. A fixed
 * pad makes every refusal identical, which is unconditionally unobservable. Jitter
 * would add a distribution whose MEAN still shifts with the underlying work, so
 * enough samples would recover what the pad was meant to hide.
 *
 * WHAT THIS COSTS, stated rather than discovered later: an attacker holds a
 * connection 2.5s per refused request instead of milliseconds. That is a real cost
 * and it is bounded elsewhere — 30 authorize calls per minute per IP, and six
 * concurrent outbound fetches, both in the layers added the same day. Without
 * those, this padding would be a denial-of-service amplifier rather than a defence.
 *
 * The SUCCESS path is never padded. A successful fetch tells an attacker only that
 * a host serves a valid document declaring their own client_id, which they must
 * already control for it to be valid at all.
 */
const OPAQUE_FLOOR_MS = 2_500;

/** Wait until `startedAt` is at least `floorMs` old. */
async function padUntil(startedAt: number, floorMs: number): Promise<void> {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= floorMs) return;
    await new Promise((resolve) => setTimeout(resolve, floorMs - elapsed));
}

/**
 * Is this address one we must never fetch?
 *
 * Covers the same ranges the site's own URL validator rejects: loopback,
 * link-local (including the cloud metadata endpoint at
 * 169.254.169.254), the three RFC 1918 blocks, carrier-grade NAT, and the IPv6
 * equivalents. Written out rather than pulled from a package so the list is
 * auditable here, next to the reason it exists.
 */
/**
 * The IPv4 address embedded in an IPv6 literal, in dotted form — or null.
 *
 * Recognises the three spellings that reach us:
 *   ::ffff:169.254.169.254   IPv4-mapped, dotted   (what a human writes)
 *   ::ffff:a9fe:a9fe         IPv4-mapped, hex      (what WHATWG URL produces)
 *   ::a9fe:a9fe              IPv4-compatible       (deprecated, still routable)
 */
function embeddedIPv4(v6: string): string | null {
    const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v6);
    if (dotted?.[1] !== undefined) return dotted[1];

    const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (hex?.[1] === undefined || hex[2] === undefined) return null;
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedAddress(ip: string): boolean {
    if (isIP(ip) === 6) {
        const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
        /* An IPv4 address embedded in IPv6 must be judged by the IPv4 rules, and
           finding it is subtler than it looks.
           `new URL('https://[::ffff:169.254.169.254]')` reports its hostname as
           `[::ffff:a9fe:a9fe]` — WHATWG normalisation rewrites the dotted quad
           into hex groups. A check written against the dotted form therefore sees
           nothing and waves the cloud metadata endpoint through; measured
           2026-09-12, that is exactly what happened here, and only the fetch
           failing hid it. Both spellings are handled, and so is the deprecated
           IPv4-compatible form (`::a9fe:a9fe`). */
        const embedded = embeddedIPv4(v6);
        if (embedded !== null) return isBlockedAddress(embedded);

        /* ⚠ `startsWith('fe80:')` was WRONG, and measured wrong on 2026-09-12.
         * Link-local is **fe80::/10**, not fe80::/16 — the first ten bits are
         * fixed, so the first hextet may be anything from fe80 to febf. `fe90::1`,
         * `fea0::1`, `feb0::1` and `febf:ffff::1` all passed the old test.
         *
         * Honest about reach: on a normal Linux host none of these route anywhere
         * without a scope id, so no internal target was actually exposed. They are
         * blocked anyway — a guard whose correctness depends on the host's routing
         * table is a guard nobody can reason about.
         *
         * Compared on the first hextet as a NUMBER rather than by string prefix,
         * which is what made the original wrong. */
        const firstHextet = parseInt(v6.split(':')[0] || '0', 16);
        return v6 === '::1' || v6 === '::'
            || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)   // fe80::/10 link-local
            || (firstHextet >= 0xfec0 && firstHextet <= 0xfeff)   // fec0::/10 site-local (deprecated)
            || (firstHextet >= 0xfc00 && firstHextet <= 0xfdff)   // fc00::/7  unique-local
            || (firstHextet >= 0xff00)                            // ff00::/8  multicast
            /* Three translation prefixes that carry an IPv4 destination inside an
               IPv6 address, so a blocked v4 target can be reached through them on a
               network that routes them: NAT64 (real on IPv6-only cloud networks),
               6to4, and Teredo. Refused wholesale rather than decoded — we have no
               business fetching a client_id document through any of them. */
            || v6.startsWith('64:ff9b:')                          // NAT64 RFC 6052
            || firstHextet === 0x2002                             // 6to4  RFC 3056
            || v6.startsWith('2001:0:') || v6.startsWith('2001::');// Teredo RFC 4380
    }
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = p as [number, number, number, number];
    return a === 0                              // 0.0.0.0/8
        || a === 10                             // private
        || a === 127                            // loopback — the whole /8, not just .0.1
        || (a === 100 && b >= 64 && b <= 127)   // carrier-grade NAT
        || (a === 169 && b === 254)             // link-local + cloud metadata
        || (a === 172 && b >= 16 && b <= 31)    // private
        || (a === 192 && b === 168)             // private
        || (a === 192 && b === 0 && c === 0)    // IETF protocol assignments
        || (a === 192 && b === 0 && c === 2)    // TEST-NET-1
        || (a === 192 && b === 88 && c === 99)  // 6to4 relay anycast
        || (a === 198 && (b === 18 || b === 19))// benchmarking
        || (a === 198 && b === 51 && c === 100) // TEST-NET-2
        || (a === 203 && b === 0 && c === 113)  // TEST-NET-3
        || a >= 224;                            // multicast + reserved
}

/**
 * Reject a client_id URL we must not fetch.
 *
 * @param allowPrivate Development only — mirrors the site validator's own
 *                     local exception so the flow can be exercised against a local
 *                     stub. Never true in production.
 */
async function assertFetchable(raw: string, allowPrivate: boolean): Promise<URL> {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new ClientError('client_id must be an absolute URL.');
    }
    /* https only. The document carries the redirect_uris we are about to trust,
       so fetching it over plaintext would let anyone on the path choose where
       the authorization code is sent. The site's validator permits http; here it
       must not, and the stricter rule is deliberate. */
    if (u.protocol !== 'https:' && !allowPrivate) {
        throw new ClientError('client_id must use https.');
    }
    if (u.username !== '' || u.password !== '') {
        throw new ClientError('client_id must not contain credentials.');
    }
    if (u.hash !== '') {
        throw new ClientError('client_id must not contain a fragment.');
    }
    const port = u.port === '' ? (u.protocol === 'http:' ? 80 : 443) : Number(u.port);
    if (!allowPrivate && !ALLOWED_PORTS.has(port)) {
        throw new ClientError('client_id port is not allowed.');
    }

    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (allowPrivate) return u;

    /* Resolve and check EVERY address, not just the first. A host with one
       public and one private A record would otherwise pass on a lucky ordering
       and reach an internal service on the next attempt.
     *
     * ⚠ THIS CHECK DOES NOT PROTECT THE CONNECTION, and an earlier version of
     * this comment implied it did. Whoever supplies client_id owns that host's
     * DNS, so they can answer this lookup with a public address and the NEXT
     * lookup — the one the HTTP client makes when it actually connects — with
     * 169.254.169.254, at a one-second TTL. Two independent resolutions is
     * textbook DNS rebinding, and it defeats every rule above.
     *
     * What closes it is that the connection resolves the name ONCE, through our
     * own hook, and connects to the address we vetted: see safeLookup below.
     * This early check stays because refusing an obviously internal host before
     * opening a socket is cheaper and clearer — but it is the cheap half. */
    const addresses = isIP(host) !== 0
        ? [host]
        : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (addresses.length === 0) {
        // Collapsed with the blocked case below on purpose: distinguishing
        // "no such host" from "private host" is itself a probe.
        throw new OpaqueClientError('client_id host could not be used.');
    }
    if (addresses.some(isBlockedAddress)) {
        throw new OpaqueClientError('client_id host could not be used.');
    }
    return u;
}

/**
 * The `lookup` hook `net.connect` calls to decide where the socket goes.
 *
 * For a HOSTNAME this is the only resolution on the connect path, so the address
 * checked here is by construction the address connected to — which is what closes
 * the rebinding window described in assertFetchable. The hostname still travels as
 * SNI and in the Host header, so TLS and certificate validation are untouched;
 * pinning by rewriting the URL to an IP would have broken both.
 *
 * ⚠ AND IT IS NEVER CALLED FOR AN IP LITERAL. Measured 2026-09-12: a request to
 * `127.0.0.1` reached ECONNREFUSED without the hook being invoked once, while
 * `localhost` did invoke it — `net.connect` has nothing to resolve when the host
 * is already an address, so it skips the hook entirely. An earlier version of this
 * comment claimed this was "the ONLY place the fetch resolves the host", full
 * stop, which is false for literals.
 *
 * Nothing is exposed by that: a literal is refused in assertFetchable before any
 * socket opens. But it means the two halves are not interchangeable — literals are
 * guarded THERE and names are guarded HERE — and a test that only exercises this
 * function is not testing the literal path at all.
 *
 * Fails CLOSED in every ambiguous case: a resolution error, an empty answer, or
 * ANY blocked address among the answers refuses the whole connection rather than
 * picking a surviving one. A host that answers with both a public and a private
 * address has no business being a client_id.
 *
 * EXPORTED only so it can be tested directly, and that is not a formality: the
 * check in assertFetchable cannot be reached past by a test without running a
 * hostile DNS server, so the only way to prove this hook refuses what it claims
 * to refuse is to call it. Nothing outside this module should use it.
 */
export function safeLookup(
    hostname: string,
    options: LookupOneOptions | LookupAllOptions,
    callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number
    ) => void
): void {
    const refuse = (): void => {
        const err: NodeJS.ErrnoException = new Error('blocked address');
        err.code = 'ENOTFOUND';
        callback(err, '', undefined);
    };

    if (isIP(hostname) !== 0) {
        if (isBlockedAddress(hostname)) return refuse();
        const family = isIP(hostname);
        if (options.all === true) {
            callback(null, [{ address: hostname, family }]);
        } else {
            callback(null, hostname, family);
        }
        return;
    }

    lookup(hostname, { all: true }).then(
        (answers) => {
            if (answers.length === 0 || answers.some((a) => isBlockedAddress(a.address))) {
                return refuse();
            }
            if (options.all === true) {
                callback(null, answers);
            } else {
                const first = answers[0];
                if (first === undefined) return refuse();
                callback(null, first.address, first.family);
            }
        },
        () => refuse()
    );
}

/**
 * GET a URL as text, with the connection pinned to a vetted address.
 *
 * Written on node:http(s) rather than fetch for one reason: fetch does its own
 * DNS resolution and gives no way to intervene, so there is no version of this
 * built on fetch that is not rebindable. Everything fetch was doing here is
 * kept — no redirect is ever followed (http.request does not follow any, so
 * `manual` becomes the default rather than a flag), a hard byte cap, and a
 * timeout that destroys the socket.
 *
 * @returns status and body. A body over MAX_BYTES aborts mid-stream rather than
 *          being read and measured afterwards, so a hostile host cannot make us
 *          buffer a gigabyte to learn it was too big.
 */
async function getWithPinnedLookup(
    url: URL,
    allowPrivate: boolean
): Promise<{ status: number; body: string }> {
    const client = url.protocol === 'http:' ? http : https;
    return await new Promise((resolve, reject) => {
        const req = client.request(
            url,
            {
                method: 'GET',
                headers: { accept: 'application/json' },
                // Local development talks to vidofy.local, which is exactly what
                // the hook exists to refuse — so it is bypassed there, the same
                // way the address rules above are.
                ...(allowPrivate ? {} : { lookup: safeLookup }),
            },
            (res) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_BYTES) {
                        res.destroy();
                        reject(new OpaqueClientError('client_id document is too large.'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
                res.on('error', reject);
            }
        );
        /* TWO timers, because setTimeout alone does not bound this request.
         *
         * `req.setTimeout` is an INACTIVITY timer: it fires only when the socket
         * has been quiet for TIMEOUT_MS. Measured 2026-09-12 — a hostile server
         * writing one byte every three seconds held the request open for 18,013 ms
         * and never tripped it; at one byte per three seconds up to the 8 KB cap
         * that is roughly eleven hours, on an endpoint anyone can call with no
         * credential. The comment above said "a timeout that destroys the socket",
         * which was true and insufficient.
         *
         * The deadline is the real bound; the inactivity timer stays because it
         * frees a dead socket sooner than the deadline would. */
        req.setTimeout(TIMEOUT_MS, () => {
            req.destroy(new Error('timeout'));
        });
        const deadline = setTimeout(() => {
            req.destroy(new Error('deadline'));
        }, TIMEOUT_MS);
        const clearDeadline = (): void => { clearTimeout(deadline); };
        req.on('close', clearDeadline);
        req.on('error', (err) => { clearDeadline(); reject(err); });
        req.end();
    });
}

const str = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s === '' ? null : s;
};

/**
 * Fetch and validate a client's metadata document.
 *
 * The public entry point, and the ONLY place the opaque/verbatim policy is applied
 * — so there is one answer to "what does a stranger learn from a refusal" instead
 * of one per throw site. Everything below it throws the truth; this decides what
 * leaves the building, and logs the truth either way.
 *
 * @throws ClientError whose message is safe to surface, always.
 */
export async function fetchClientMetadata(
    clientId: string,
    opts: { allowPrivate?: boolean } = {}
): Promise<ClientInfo> {
    const startedAt = Date.now();
    try {
        return await fetchClientMetadataInner(clientId, opts);
    } catch (err) {
        if (err instanceof OpaqueClientError) {
            /* The real reason, on our side, always — this is what keeps the change
               from costing anyone anything. The client_id is included because
               without it a log of these is unreadable, and it is a URL the caller
               chose to send us, not a secret. */
            log(`client_id refused: ${err.message} — ${clientId}`);
            await padUntil(startedAt, OPAQUE_FLOOR_MS);
            throw new ClientError(OPAQUE_MESSAGE);
        }
        /* Group A and the concurrency cap pass through untouched, and are NOT
           padded: their messages already say everything, so their timing reveals
           nothing further, and padding them would only make a developer's typo
           take two and a half seconds to report. */
        throw err;
    }
}

async function fetchClientMetadataInner(
    clientId: string,
    opts: { allowPrivate?: boolean } = {}
): Promise<ClientInfo> {
    /* The URL is validated BEFORE the cache is consulted, not after.
     *
     * It costs a parse on a cache hit, and it buys the guarantee that a value which
     * would be refused today cannot be served from a cache filled yesterday — if
     * the address rules ever change, or a host that was public becomes internal,
     * the cache must not be the way around them. Cheap, and the alternative is a
     * stale exemption nobody can see. */
    const url = await assertFetchable(clientId, opts.allowPrivate === true);

    const cached = docCache.get(clientId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
        return cached.info;
    }
    if (cached !== undefined) docCache.delete(clientId);

    /* The concurrency ceiling. Checked here rather than inside the fetch so the
       counter cannot be leaked by an early throw between the two. */
    if (inFlight >= MAX_CONCURRENT_FETCHES) {
        throw new ClientError('Too many authorization requests are in progress. Try again shortly.');
    }

    let res: { status: number; body: string };
    inFlight++;
    try {
        res = await getWithPinnedLookup(url, opts.allowPrivate === true);
    } catch (err) {
        // A ClientError already carries a message written to be shown; anything
        // else is a socket-level failure and must not describe our network.
        if (err instanceof ClientError) throw err;
        throw new OpaqueClientError('client_id document could not be fetched.');
    } finally {
        /* finally, so a throw anywhere above cannot leave the counter raised. A
           leaked count here would be permanent: six leaked and this endpoint is
           closed until the process restarts, which is a worse outage than the one
           the cap prevents. */
        inFlight--;
    }
    /* A redirect is a second URL none of the guards above ever saw — the classic
       bypass is a public host that 302s to 169.254. node:http follows nothing on
       its own, so this is a refusal rather than a setting. */
    if (res.status >= 300 && res.status < 400) {
        throw new OpaqueClientError('client_id document must not redirect.');
    }
    if (res.status < 200 || res.status >= 300) {
        throw new OpaqueClientError(`client_id document returned ${res.status}.`);
    }

    // The size cap is enforced mid-stream now (see getWithPinnedLookup), so by
    // here the body is already known to be within it.
    const body = res.body;
    let doc: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('not an object');
        }
        doc = parsed as Record<string, unknown>;
    } catch {
        throw new OpaqueClientError('client_id document is not a JSON object.');
    }

    /* The document must not claim a DIFFERENT client_id from the URL we fetched it
       from, or host A could serve a document declaring itself to be host B.

       An ABSENT client_id is tolerated, and the previous comment ("the document
       MUST claim the same client_id") overstated what the code does. Tolerating it
       is safe here and not an oversight: the identity we return below is always
       `clientId`, the URL we fetched — the document's own value is never adopted,
       only compared. So a missing field grants nothing; it just skips a comparison
       that had nothing to compare. */
    const declared = str(doc['client_id']);
    if (declared !== null && declared !== clientId) {
        throw new OpaqueClientError('client_id document declares a different client_id.');
    }

    const uris = Array.isArray(doc['redirect_uris'])
        ? doc['redirect_uris'].map(str).filter((s): s is string => s !== null)
        : [];
    if (uris.length === 0) {
        throw new OpaqueClientError('client_id document declares no redirect_uris.');
    }

    const info: ClientInfo = {
        clientId,
        /* The name goes on a consent screen the user reads to decide. Falling back
         * to the host keeps it truthful when the field is missing, rather than
         * showing something friendlier than the document supports.
         *
         * CAPPED, and the cap is the point rather than tidiness: this string is
         * wholly attacker-chosen and unbounded up to the 8 KB document limit. The
         * consent screen escapes it, so there is no injection — but ~8 KB of text
         * in the heading pushes the "verified as <host>" line, the one thing that
         * contradicts a name like "Claude", off the visible page. A phishing client
         * gets 60 characters, next to a host it cannot forge. */
        clientName: (str(doc['client_name']) ?? url.host).slice(0, MAX_CLIENT_NAME),
        redirectUris: uris,
        clientUri: str(doc['client_uri']),
        logoUri: str(doc['logo_uri']),
    };

    /* Cached only now, at the end, so nothing that threw above can be remembered.
       Eviction is oldest-first via Map insertion order — not a true LRU, and it
       does not need to be: the cap exists to bound memory against rotating urls,
       and the handful of real client_ids are refreshed on every hit anyway. */
    if (docCache.size >= DOC_CACHE_MAX) {
        const oldest = docCache.keys().next();
        if (oldest.done !== true) docCache.delete(oldest.value);
    }
    docCache.set(clientId, { info, expiresAt: Date.now() + DOC_CACHE_TTL_MS });

    return info;
}

/**
 * Is this redirect_uri one the client declared?
 *
 * Exact string comparison, which is what OAuth 2.1 requires and what makes the
 * check worth having: any normalisation (trailing slash, case, added query) is a
 * place where "close enough" sends the authorization code somewhere the client
 * never listed.
 */
export function redirectUriAllowed(client: ClientInfo, redirectUri: string): boolean {
    return client.redirectUris.includes(redirectUri);
}
