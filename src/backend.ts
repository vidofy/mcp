/**
 * The one place that talks to Vidofy over HTTP.
 *
 * Everything else in this package builds a request description and hands it
 * here, so door selection, authentication, retries, timeouts and error shape
 * are decided once instead of in nine tools.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR
 *   · picking /app/v1 or /api/v1 from the configured mode
 *   · attaching the credential and the User-Agent on every call
 *   · multipart bodies — one form field per m_* key, exactly as the studio posts
 *   · carrying an Idempotency-Key when the caller supplies one
 *   · retrying the things that are worth retrying, and nothing else
 *   · turning both transport failures and API error envelopes into one error type
 */

import { readFile, lstat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

import { type Config, apiPrefix, authHeaders } from './config.js';
// map/ imports nothing, so this direction cannot cycle.
import { stripProviderCost } from './map/b2c.js';
import { durationSecFromBuffer } from './media-duration.js';

/* ── errors ──────────────────────────────────────────────────────────────── */

/**
 * Anything that went wrong, from either side of the wire.
 *
 * `code` is the machine-readable one — the API's own `error` field where there
 * was a response, or a transport pseudo-code where there was not. `message` is
 * what a person (or a model) should read.
 */
export class VidofyError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly httpStatus: number | null = null,
        /** Extra fields the API returned, e.g. `allowed` on INVALID_MODE. */
        public readonly details: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'VidofyError';
    }
}

/* ── retry policy ────────────────────────────────────────────────────────── */

/**
 * Retry a rate limit, a gateway hiccup and a dropped connection. Nothing else.
 *
 * Every other 4xx is deterministic — a missing field, an unknown model, a
 * revoked token, an empty balance. Retrying those burns the user's time to
 * arrive at the same answer, and on a 402 it would look like the server is
 * being asked to charge repeatedly.
 */
function isRetryableStatus(status: number): boolean {
    return status === 429 || status === 502 || status === 503 || status === 504;
}

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter matters even for one client: an agent fires several tools at once, and
 * without it their retries line up and hit the same rate limit together.
 * Retry-After wins when the server sends one. /api/v1 now does, on 429, and the
 * value is exact rather than a guess because the limiter uses a fixed window
 * (per-minute and per-day) so it knows precisely when the window turns over.
 * /app/v1's own 60/min limiter
 * sends none, and that door is the one this server actually speaks to, so the
 * jitter below is still the live path.
 */
function backoffDelayMs(attempt: number, retryAfterHeader: string | null): number {
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1000, 30_000);
        }
    }
    const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, 8_000);
    return Math.random() * ceiling;
}

/** Exported for get_status, which holds its call open rather than letting the
 *  agent poll in a tight loop — one definition, not a second one that drifts. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ── requests ────────────────────────────────────────────────────────────── */

/** A local file to attach to a multipart request. */
export interface FileField {
    /** The form field name — m_image, m_first_frame, m_multi_image_file_0, … */
    field: string;
    /** Absolute or relative path on the machine running this server. */
    path: string;
    /**
     * Extensions this slot accepts, with or without the dot. Comes from the
     * model's own m_upload_*_settings via get_model, already defaulted the way
     * the server defaults them. REQUIRED in practice: an empty or missing list
     * is refused, not waved through — see the check in buildBody.
     */
    accept?: readonly string[];
    /** The slot's max_size in megabytes, from the same place. */
    maxSizeMb?: number;
    /**
     * The slot's max_duration in seconds, from the same place. 0/absent = no
     * cap. Enforced only when the file's own header states its length exactly
     * — see media-duration.ts for which formats those are, and why a guess is
     * not allowed to refuse an upload.
     */
    maxDurationSec?: number;
}

/**
 * A ceiling that applies even when the model declares none.
 *
 * It is not a policy about what Vidofy accepts — the server decides that. It is
 * a guard on THIS process: readFile() buffers the whole file and Blob copies it
 * again, so a path pointing at a 4 GB file takes the MCP server down with an
 * OOM, and the AI client reports only that the connection died.
 */
const HARD_MAX_BYTES = 512 * 1024 * 1024;

export interface RequestOptions {
    method: 'GET' | 'POST';
    /** Path AFTER the version prefix, e.g. 'info/modes'. No leading slash. */
    path: string;
    query?: Record<string, string | number | undefined>;
    /**
     * Form fields. Sent as multipart when `files` is present, otherwise as
     * application/x-www-form-urlencoded — the two shapes the submit handler
     * reads. JSON is deliberately NOT used on the account door: measured in
     * early testing, a JSON body from a session caller is not decoded at all by
     * the submit handler, so it would silently lose every field.
     */
    form?: Record<string, string | number | boolean | undefined>;
    files?: FileField[];
    /**
     * Same value across every retry of one logical call — that is what makes
     * retrying a POST safe rather than a way to pay twice. Generated once by
     * the caller, never here.
     */
    idempotencyKey?: string;
    timeoutMs?: number;
    /**
     * Return the body instead of throwing when a 200 carries `success: false`.
     *
     * For the two endpoints that report on a JOB: a generation that failed is
     * a successful call whose answer happens to be bad news, and the caller's
     * mapper is what turns it into `{done:true, status:'failed'}`. Everywhere
     * else an envelope error is still an error.
     */
    allowEnvelopeError?: boolean;
    /**
     * Cap the attempts for this call. Defaults to MAX_ATTEMPTS.
     *
     * `generate` sets 1. Retrying it is safe on the SERVER — the
     * Idempotency-Key dedupes — but the whole budget still has to finish
     * inside the client's 60s tool-call timeout, or the client gives up while
     * the charge lands and the agent retries with a new key. One attempt, well
     * inside the window, beats four that outlive the caller.
     */
    maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/* ONE ceiling for a whole call, retries and backoff included.
 *
 * DEFAULT_TIMEOUT_MS is PER ATTEMPT, and attempts compose by ADDING: four of
 * them plus backoff is 264s. The MCP SDK's DEFAULT_REQUEST_TIMEOUT_MSEC is
 * 60s, so every one of those calls was still trying, alone, minutes after the
 * client had given up and told the user it failed — and get_status/get_result,
 * the two that are called over and over while a generation runs, were among
 * them. `generate` was given a deadline for exactly this reason; it is the
 * transport that should carry it, not one of the nine tools.
 *
 * 55s leaves the client a margin to hear the answer. A per-attempt timeout can
 * still be shorter (generate's submit sets 50s) — this is the ceiling, not the
 * allowance. */
const CALL_BUDGET_MS = 55_000;

/* Below this there is no point starting another attempt: the sleep plus a
 * one-second window buys a near-certain second failure and spends the last of
 * the time the caller could have used to hear about the first. */
const MIN_ATTEMPT_MS = 2_000;

/** Content types this package will attach, keyed by extension. */
const MIME: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};

function guessMime(path: string): string {
    return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** A fresh idempotency key. Callers make ONE per logical operation. */
export function newIdempotencyKey(): string {
    return randomUUID();
}

/**
 * An idempotency key derived from WHAT IS BEING ASKED FOR, inside a window.
 *
 * The server dedupes on (user, origin, m_client_request_id) and this package
 * sent a randomUUID() per invocation, so that tuple could never repeat and
 * the dedupe could never fire: two identical generate calls were two
 * generations and two charges. The mechanism existed on both sides and was
 * joined by a value guaranteed to differ.
 *
 * NO TIME COMPONENT IN THE KEY, deliberately — that was tried and is wrong.
 * The expiry a derived key needs (the same prompt next week must generate
 * again, not replay) is a property of the LOOKUP, and it now lives there:
 * The server's idempotent-lookup takes a max age and the submit
 * handler passes 60 seconds for an MCP caller. Hashing a time bucket into the
 * key instead makes a tumbling grid, so two calls seconds apart miss each
 * other whenever a boundary falls between them — measured on the first live
 * pair tried: 11 seconds apart, two jobs, two charges. A bound on the query
 * is a real "within 60s of each other" at any alignment.
 *
 * Files are identified by path AND by size+mtime, so editing an image and
 * re-running inside the window is a different request rather than a cached
 * answer. A path that cannot be stat'd contributes its raw path and the real
 * complaint arrives later, from the code whose job that is.
 */
export function contentIdempotencyKey(
    parts: Record<string, unknown>,
    filePaths: readonly string[] = []
): string {
    const fileTags = [...filePaths].sort().map((p) => {
        try {
            const s = statSync(p);
            return `${p}:${s.size}:${Math.floor(s.mtimeMs)}`;
        } catch {
            return p;
        }
    });
    // Sorted keys: {a,b} and {b,a} are the same request and must not become
    // two. JSON.stringify preserves insertion order, which the caller's object
    // literal does not control.
    const canonical = JSON.stringify(parts, Object.keys(parts).sort());
    return createHash('sha256')
        .update(`${canonical}\n${fileTags.join('\n')}`)
        .digest('hex');
}

/**
 * Build the body. Multipart when files are involved, urlencoded otherwise.
 *
 * fetch sets its own Content-Type (with the boundary) for FormData, so this
 * never sets that header itself — doing so produces a body the server cannot
 * parse, and the symptom is an empty $_POST rather than an error.
 */
/* The three shapes this actually produces. Spelled out rather than typed as
   the DOM's BodyInit, because pulling "DOM" into `lib` for one alias would
   also bring window, document and fetch's browser overloads into a package
   that runs only under Node. */
type RequestBody = URLSearchParams | FormData | undefined;

/** The body, plus how many file bytes went into it — for the 413 message. */
interface BuiltBody {
    body: RequestBody;
    uploadBytes: number;
}

async function buildBody(opts: RequestOptions): Promise<BuiltBody> {
    if (opts.method === 'GET') return { body: undefined, uploadBytes: 0 };

    const entries = Object.entries(opts.form ?? {}).filter(
        (e): e is [string, string | number | boolean] => e[1] !== undefined
    );

    if (!opts.files || opts.files.length === 0) {
        const params = new URLSearchParams();
        for (const [k, v] of entries) params.append(k, String(v));
        return { body: params, uploadBytes: 0 };
    }

    let uploadBytes = 0;

    const fd = new FormData();
    for (const [k, v] of entries) fd.append(k, String(v));

    for (const f of opts.files) {
        let bytes: Buffer;
        try {
            /* lstat, NOT stat: stat follows symlinks, so a file the agent was
               told to send as "photo.png" could be a link to ~/.ssh/id_rsa and
               every check below would inspect the harmless name while readFile
               returned the key. The link itself is refused instead. */
            const info = await lstat(f.path);
            if (info.isSymbolicLink()) {
                throw new VidofyError(
                    'FILE_IS_SYMLINK',
                    `Refusing to upload a symbolic link: ${f.path}. Pass the real file.`
                );
            }
            if (!info.isFile()) {
                throw new VidofyError('FILE_NOT_A_FILE', `Not a file: ${f.path}`);
            }

            /* Checked BEFORE the read, against the model's own limits, for two
               separate reasons. The size one is ours: a 40 MB file sent to a
               10 MB slot costs the user the whole upload to arrive at a 422 it
               cannot diagnose. The extension one is the user's: the path comes
               from the conversation, so anything that talks the model into
               naming a private file gets those bytes off the machine. This does
               not make that safe — a real .png anywhere on disk still passes —
               which is why `generate` is not readOnly and the client shows the
               path to the user before it runs. */
            /* Both sides normalised to a bare, lower-case extension. The model
               declares them WITHOUT a dot ("jpg", "png" — straight out of
               m_upload_*_settings.allowed_extensions) while extname() returns
               one (".png"), so comparing them raw refuses every legitimate
               upload. Accepting either form here means a caller cannot get it
               subtly wrong. */
            const bare = (e: string): string => e.trim().toLowerCase().replace(/^\./, '');
            const ext = bare(extname(f.path));
            const accepted = (f.accept ?? []).map(bare).filter((e) => e !== '');
            /* No allowlist means REFUSE, not "allow anything".
             *
             * This read `accepted.length > 0 && …` until 2026-09-07, so a slot
             * that declared no extensions switched the check off entirely — and
             * 10+ active models declare none. The caller now always resolves
             * the server's own defaults first (schema.ts resolveUploadRules),
             * so an empty list here means the limits are genuinely unknown, and
             * a file whose type we cannot vouch for is exactly the one not to
             * read off the user's disk. */
            if (accepted.length === 0) {
                throw new VidofyError(
                    'UPLOAD_LIMITS_UNKNOWN',
                    `No accepted file types are known for ${f.field}; refusing to upload ` +
                        `${basename(f.path)}. Call get_model to see the slot's limits.`
                );
            }
            if (!accepted.includes(ext)) {
                throw new VidofyError(
                    'FILE_TYPE_REJECTED',
                    `${basename(f.path)} is ${ext ? '.' + ext : 'extensionless'}; ` +
                        `${f.field} accepts ${accepted.map((e) => '.' + e).join(', ')}.`
                );
            }
            const limitBytes = Math.min(
                f.maxSizeMb !== undefined ? f.maxSizeMb * 1024 * 1024 : HARD_MAX_BYTES,
                HARD_MAX_BYTES
            );
            if (info.size > limitBytes) {
                throw new VidofyError(
                    'FILE_TOO_LARGE',
                    `${basename(f.path)} is ${(info.size / 1048576).toFixed(1)} MB; ` +
                        `${f.field} accepts up to ${(limitBytes / 1048576).toFixed(0)} MB.`
                );
            }

            bytes = await readFile(f.path);

            /* Length, checked HERE because here it is free.
             *
             * The bytes are already in memory and nothing has gone on the wire
             * yet, so reading the container costs no I/O and still saves the
             * whole upload — which is the point: nine models cap what you send
             * (30s of video on lipsync and motion-control, 30-600s of audio),
             * and a 200 MB clip otherwise travels in full to be told it is
             * fifteen seconds too long.
             *
             * null means the format does not state its length exactly, and
             * then nothing is refused — the server checks authoritatively and
             * says so clearly, before charging. Refusing on an inferred number
             * would trade a saved upload for a rejected valid file. */
            const cap = f.maxDurationSec ?? 0;
            if (cap > 0) {
                const seconds = durationSecFromBuffer(bytes, extname(f.path));
                // Ceil to match the server, which compares ceil(duration)
                // against the same cap.
                if (seconds !== null && Math.ceil(seconds) > cap) {
                    throw new VidofyError(
                        'FILE_TOO_LONG',
                        `${basename(f.path)} is ${Math.ceil(seconds)}s; ` +
                            `${f.field} accepts up to ${cap}s. Trim it and try again — ` +
                            'nothing was uploaded and nothing was charged.'
                    );
                }
            }
        } catch (err) {
            if (err instanceof VidofyError) throw err;
            throw new VidofyError(
                'FILE_UNREADABLE',
                `Could not read ${f.path}: ${err instanceof Error ? err.message : String(err)}`
            );
        }
        // One form field per m_* key — the same shape the studio's FormData
        // produces, which is why the server needs no special case for us.
        fd.append(f.field, new Blob([bytes], { type: guessMime(f.path) }), basename(f.path));
        uploadBytes += bytes.length;
    }
    return { body: fd, uploadBytes };
}

/** Strip anything that could echo the credential back into a log or a tool result. */
function redact(text: string, cfg: Config): string {
    return cfg.credential ? text.split(cfg.credential).join('«credential»') : text;
}

/**
 * Perform one request, with retries.
 *
 * Returns the parsed JSON body on success. Throws VidofyError on anything else,
 * including a 200 whose envelope says `success: false`.
 */
export async function request<T = unknown>(cfg: Config, opts: RequestOptions): Promise<T> {
    const url = new URL(cfg.baseUrl + apiPrefix(cfg) + '/' + opts.path.replace(/^\/+/, ''));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
        ...authHeaders(cfg),
        'User-Agent': cfg.userAgent,
        Accept: 'application/json',
    };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let lastError: VidofyError | null = null;

    /* Built ONCE, before the loop.
     *
     * It used to be rebuilt per attempt, on the theory that a consumed FormData
     * is not replayable. It is: undici re-reads the Blob on each send. What the
     * old placement actually did was re-read every file from disk on every
     * retry — four disk reads and four full uploads for one 20 MB image — and,
     * worse, a file edited between attempts went out as different bytes under
     * the SAME Idempotency-Key, which is precisely the case that key exists to
     * make identical. */
    const { body, uploadBytes } = await buildBody(opts);

    // Per-call cap; see RequestOptions.maxAttempts.
    const attempts = Math.max(1, Math.min(opts.maxAttempts ?? MAX_ATTEMPTS, MAX_ATTEMPTS));

    /* The wall clock for the whole call — see CALL_BUDGET_MS. Fixed here,
     * before the first attempt, so it bounds the attempts AND the backoff
     * between them rather than restarting with each one. */
    const deadline = Date.now() + CALL_BUDGET_MS;
    const remainingMs = (): number => deadline - Date.now();

    /* Is there time for another attempt, and if so wait out the backoff.
     *
     * Returns false when the attempts are spent OR the budget is — and the
     * second half is the point: without it, a fourth attempt was still being
     * started long after the client had stopped listening. Only sleeps when it
     * is going to say yes, so a caller writing
     *   `if (isRetryable(...) && await canRetry(...)) continue;`
     * pays nothing when the status is not retryable. */
    const canRetry = async (attempt: number, retryAfter: string | null): Promise<boolean> => {
        if (attempt >= attempts - 1) return false;
        const delay = backoffDelayMs(attempt, retryAfter);
        if (remainingMs() - delay < MIN_ATTEMPT_MS) return false;
        await sleep(delay);
        return true;
    };

    for (let attempt = 0; attempt < attempts; attempt++) {
        /* What THIS attempt gets: its own timeout, or whatever is left of the
         * call's budget, whichever is smaller. The floor keeps
         * AbortSignal.timeout out of the range where it aborts instantly — a
         * request that never left is reported as a timeout it did not have. */
        const attemptTimeoutMs = Math.max(
            1_000,
            Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingMs())
        );
        /* `body` is OMITTED rather than passed as undefined: with
           exactOptionalPropertyTypes a GET carrying `body: undefined` is not
           the same thing as a GET with no body, and undici rejects the former. */
        const init: RequestInit = {
            method: opts.method,
            headers,
            signal: AbortSignal.timeout(attemptTimeoutMs),
            /* Never follow a redirect. undici strips Authorization across
               origins but forwards X-API-Key, so a redirect to another host
               would hand that credential over. Nothing on /app/v1 or /api/v1
               redirects; if one starts, failing is the right answer. */
            redirect: 'error',
        };
        if (body !== undefined) init.body = body;

        let res: Response;
        try {
            res = await fetch(url, init);
        } catch (err) {
            const name = err instanceof Error ? err.name : '';
            const isTimeout = name === 'TimeoutError' || name === 'AbortError';
            lastError = new VidofyError(
                isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
                isTimeout
                    // The EFFECTIVE timeout, which is not always opts.timeoutMs:
                    // a later attempt gets whatever is left of the call budget,
                    // and reporting the requested figure would name a wait that
                    // did not happen.
                    ? `Vidofy did not answer within ${Math.round(attemptTimeoutMs / 1000)}s.`
                    : `Could not reach ${url.origin}: ${redact(err instanceof Error ? err.message : String(err), cfg)}`
            );
            if (await canRetry(attempt, null)) continue;
            throw lastError;
        }

        /* Reading the body can fail on its own — the headers arrived, then the
           connection dropped or the per-attempt timeout fired mid-stream. That
           used to throw a raw TypeError/DOMException straight out of this
           function: not a VidofyError, and NOT retried, even though the very
           same failure one line earlier (during fetch) is retried. Same class
           of failure, same treatment. */
        let text: string;
        try {
            text = await res.text();
        } catch (err) {
            const name = err instanceof Error ? err.name : '';
            const isTimeout = name === 'TimeoutError' || name === 'AbortError';
            lastError = new VidofyError(
                isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
                `Vidofy answered ${res.status} but the response body did not arrive: ` +
                    redact(err instanceof Error ? err.message : String(err), cfg)
            );
            if (await canRetry(attempt, res.headers.get('retry-after'))) continue;
            throw lastError;
        }

        let parsed: unknown = null;
        try {
            parsed = text === '' ? null : JSON.parse(text);
        } catch {
            /* Not JSON. An admin account gets HTML back from some endpoints,
               and a proxy error page is HTML too — either way, saying "the
               server did not return JSON" beats a JSON.parse stack trace. */
            if (isRetryableStatus(res.status) && await canRetry(attempt, res.headers.get('retry-after'))) {
                continue;
            }
            /* 413 is the one status that reliably arrives as HTML, because
               nginx/PHP refuse the body before any Vidofy code runs — so
               there is no JSON envelope to read and no message to relay.
               Saying "non-JSON body" there would hide the only fact that
               matters, which is that the upload was too big for the server
               and not for the model. */
            if (res.status === 413) {
                throw new VidofyError(
                    'UPLOAD_TOO_LARGE',
                    `Vidofy refused the upload before reading it: ${(uploadBytes / 1048576).toFixed(1)} MB ` +
                        'exceeded the server\'s total request limit. Send fewer or smaller files — ' +
                        'the per-file limits from get_model are separate and were satisfied.',
                    413
                );
            }
            throw new VidofyError(
                'NON_JSON_RESPONSE',
                `Vidofy returned ${res.status} with a non-JSON body (${text.length} bytes).`,
                res.status
            );
        }

        const envelope = (parsed ?? {}) as Record<string, unknown>;
        const apiCode = typeof envelope['error'] === 'string' ? envelope['error'] : null;
        const apiMessage = typeof envelope['message'] === 'string' ? envelope['message'] : null;

        if (res.ok && envelope['success'] !== false) {
            return parsed as T;
        }

        /* A generation that FAILED is not a failed call.
         *
         * The status endpoint answers HTTP 200 with success:false and
         * error:'FAILED'|'ERROR'|'BLOCKED' for a job that reached a terminal
         * failure — the full data object is right there beside it. Treating
         * that as a transport error threw before the mapper ever ran, so
         * get_status could never report {done:true, status:'failed'} and the
         * agent could not tell "your video was blocked" from "Vidofy is
         * unreachable". It also made three of the five entries in the mapper's
         * TERMINAL set dead code, covering thousands of real rows.
         *
         * Only the callers that read a job set this, and only on a 200 — every
         * other envelope error still throws. */
        if (res.ok && opts.allowEnvelopeError) {
            return parsed as T;
        }

        // An error, from either the status line or the envelope.
        const { success: _s, error: _e, message: _m, ...rest } = envelope;
        lastError = new VidofyError(
            apiCode ?? `HTTP_${res.status}`,
            redact(apiMessage ?? `Vidofy answered ${res.status}.`, cfg),
            res.status,
            /* Redacted AND cost-stripped, same as the message beside it.
               index.ts serialises `details` into the tool result, so anything
               left here reaches the model — including the provider cost the
               rest of this package works to keep in-house. */
            stripProviderCost(JSON.parse(redact(JSON.stringify(rest), cfg)) as Record<string, unknown>)
        );

        if (isRetryableStatus(res.status) && await canRetry(attempt, res.headers.get('retry-after'))) {
            continue;
        }
        throw lastError;
    }

    /* Unreachable: every path above either returns or throws on the last
       attempt. Present so the function is total rather than relying on that
       reasoning staying true. */
    throw lastError ?? new VidofyError('UNKNOWN', 'Request failed for an unknown reason.');
}
