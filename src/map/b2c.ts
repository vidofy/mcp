/**
 * Translate Vidofy's responses into one shape the agent always sees.
 *
 * TWO RULES GOVERN THIS FILE.
 *
 * 1. BRANCH ON THE PAYLOAD, NEVER ON THE CONFIGURED MODE.
 *    The server decides its response shape from the stored row, not from how
 *    the caller authenticated — the row's own origin selects the B2B shape. So a
 *    media row created with an API key, fetched later through /app/v1 with a
 *    personal token, comes back in the B2B shape — clean names, no m_ prefix.
 *    A mapper that
 *    keyed off "we are in account mode" would read every field as undefined and
 *    report a successful generation as an empty result.
 *
 * 2. PROVIDER COST NEVER REACHES THE AGENT.
 *    `m_api_cost` / `aul_api_cost` / `total_api_cost` are what Vidofy paid the
 *    upstream provider — the margin, from which the markup is one division
 *    away. They are stripped recursively, by name, from everything.
 *
 *    (An earlier version of this comment spelled out a real row's coins and
 *    provider cost as an illustration. That pair IS the markup — writing the
 *    secret into the file whose job is to keep it. Removed 2026-09-07.)
 *
 *    `cost_usd` is NOT one of them and is deliberately kept — but ONLY on
 *    status and result, where the server builds it from the partner-facing
 *    price. On the pricing endpoint the same name carries the provider cost
 *    instead, which is why it is emitted from the B2B shape alone and never
 *    read here; see the note beside that guard below. Partner cost is
 *    published, provider cost stays internal, and the NAME does not tell the
 *    two apart.
 */

/** Field names that carry Vidofy's own cost. None may ever be returned. */
const PROVIDER_COST_KEYS = new Set(['m_api_cost', 'aul_api_cost', 'total_api_cost', 'api_cost']);

/**
 * Remove every provider-cost field, at any depth.
 *
 * Recursive rather than a fixed list of paths: these fields sit in different
 * places in each response shape, and a new endpoint would otherwise leak
 * silently until someone noticed. Removing a key that is not there costs
 * nothing; missing one costs the margin.
 */
export function stripProviderCost<T>(value: T, depth = 0): T {
    /* A depth stop, because this runs on whatever the server sent.
     * Unbounded recursion on a deep or self-referential payload throws
     * RangeError out of the mapper, which the agent then reads as an
     * unexplained crash instead of a result. At 64 levels every real Vidofy
     * response is long finished; anything deeper is truncated rather than
     * trusted, since a value this function cannot see into is a value it
     * cannot promise is clean. */
    if (depth > 64) return null as unknown as T;

    if (Array.isArray(value)) {
        return value.map((v) => stripProviderCost(v, depth + 1)) as unknown as T;
    }
    if (value !== null && typeof value === 'object') {
        /* Null-prototype: assigning a key named `__proto__` onto a plain `{}`
           sets the prototype instead of a property, so a server response
           carrying {"__proto__":{"m_status":"success"}} made every later
           lookup inherit "success" — a failed job reading as finished. With no
           prototype there is nothing to hijack. */
        const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            // Case-insensitive: the server emits lower-case today, and that is
            // the only reason a match ever succeeded. Comparing exactly makes
            // the guard depend on the server's spelling never changing.
            if (PROVIDER_COST_KEYS.has(k.toLowerCase())) continue;
            out[k] = stripProviderCost(v, depth + 1);
        }
        return out as unknown as T;
    }
    return value;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const rec = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s === '' ? null : s;
};

const int = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
};

/* ── status ──────────────────────────────────────────────────────────────── */

export interface GenerationStatus {
    id: string | null;
    /** processing · success · error · failed · blocked */
    status: string | null;
    done: boolean;
    mode: string | null;
    model: string | null;
    credits_charged: number | null;
    estimated_seconds: number | null;
    elapsed_seconds: number | null;
    created_at: string | null;
    completed_at: string | null;
    error: string | null;
    /** Present only on rows billed to the API credit wallet — the partner's own price. */
    cost_usd?: number | null;
}

/**
 * Every state a row can END in. Measured from the server, not assumed:
 *   success · pending · error · failed · blocked · deleted_media
 *
 * `deleted_media` is the one that is easy to miss and expensive to miss — it is
 * what retention leaves behind after the media is swept (30 days free, 180 for
 * a subscriber), the server does not classify it as an error, and rows already
 * carry it today. Off this list the agent sees done:false on a
 * row that will never change again and polls until something else stops it.
 */
const TERMINAL = new Set(['success', 'error', 'failed', 'blocked', 'deleted_media']);

/**
 * @param payload The whole status response, from either door and either shape.
 */
export function mapStatus(payload: unknown): GenerationStatus {
    const root = rec(stripProviderCost(payload));
    const data = rec(root['data']);

    // The tell is which naming the row came back in — B2C keeps the m_ prefix,
    // B2B strips it. Checked on the DATA, which is where the difference lives.
    const isB2bShape = data['m_id'] === undefined && data['id'] !== undefined;

    const requestStatus = str(root['request_status']);
    const rawStatus = isB2bShape ? str(data['status']) : str(data['m_status']);
    const status = requestStatus ?? rawStatus;

    const out: GenerationStatus = {
        id: str(isB2bShape ? data['id'] : data['m_id']) ?? str(root['media_id']) ?? str(root['id']),
        status,
        done: status !== null && TERMINAL.has(status),
        mode: str(isB2bShape ? data['mode'] : data['m_mode']),
        model: str(isB2bShape ? data['model_name'] : data['m_name']) ??
               str(isB2bShape ? data['model_key'] : data['m_model_key']),
        credits_charged: int(isB2bShape ? data['credits_charged'] : data['m_coins']),
        estimated_seconds: int(isB2bShape ? data['estimated_seconds'] : data['m_sec']),
        /* Two different numbers, and the server names them apart: while a job
         * is pending `elapsed_seconds` is time-since-submit, and once it is
         * finished `actual_duration_seconds` is how long it actually took.
         * Surface whichever exists, because an agent asking "how long" means
         * the live one before and the final one after, never both.
         *
         * The result endpoint only ever answers about a finished job, so it
         * carries the duration alone — reading `elapsed_seconds` there always
         * yielded null, which is what get_result reported for every generation. */
        elapsed_seconds: int(data['elapsed_seconds']) ?? int(data['actual_duration_seconds']),
        created_at: str(isB2bShape ? data['created_at'] : data['m_time']),
        /* B2B sends an ISO 8601 string under a clean name; B2C keeps the column
         * name and its plain UTC datetime. Both are populated as of the same
         * change that added them to the B2C block — before it, only the B2B
         * door answered and every first-party caller saw null. */
        completed_at: str(isB2bShape ? data['completed_at'] : data['m_completed_at']),
        error: str(isB2bShape ? data['error_message'] : data['m_api_error']) ??
               str(root['message'] === undefined ? null : (status !== null && TERMINAL.has(status) && status !== 'success' ? root['message'] : null)),
    };

    /* Gated on the B2B shape, not merely on the key being present.
     *
     * `cost_usd` means two different things on two sibling endpoints: on
     * status/result it is the PARTNER's own price and theirs to see; on the
     * pricing endpoint the same name is the PROVIDER cost, the one number this
     * file exists to keep in. Emitting it whenever it appears made the
     * distinction depend on which endpoint happened to answer — safe today only
     * because the B2C branch does not emit the key, which is a fact about the
     * server, not a property of this code. */
    if (isB2bShape && data['cost_usd'] !== undefined) out.cost_usd = int(data['cost_usd']);
    return out;
}

/* ── result ──────────────────────────────────────────────────────────────── */

/**
 * `estimated_seconds` is deliberately NOT part of a result.
 *
 * The result endpoint does not return it — only status does, from the estimate
 * snapshotted at submit — so spreading the status type in whole put the key
 * here with a null in it: 26 from get_status, then null
 * from get_result on the same generation. A field that empties itself between
 * two calls reads as data loss.
 *
 * Omitted rather than filled in, because on a FINISHED job an estimate has no
 * consumer — the actual time is right there — and the estimate is not worth
 * propagating anyway: measured 2026-09-11, real time is 6.17x it for images
 * and 2.02x for video.
 */
export interface GenerationResult extends Omit<GenerationStatus, 'estimated_seconds'> {
    media_type: string | null;
    url: string | null;
    thumbnail_url: string | null;
    dimensions: string | null;
    /** How long the URL stays valid, in words, because it is not forever. */
    url_note: string | null;
    /**
     * Bytes of the output file, or null when the row never recorded one.
     *
     * Read so a preview can be refused BEFORE it is fetched: outputs average
     * 2.5 MB and reach 27 MB, and a file too large to inline should cost no
     * download at all. null means unknown, never empty — the fetch falls back
     * to Content-Length in that case.
     */
    output_size: number | null;
    /**
     * A link that SAVES the file rather than displaying it — presigned by the
     * server with Content-Disposition: attachment. Short-lived, ten minutes:
     * it is clicked at once or not at all.
     *
     * The card's Download button has no other way to exist. MCP Apps runs the
     * view in a sandboxed iframe and defines NO download method — the whole
     * view-to-host list is ui/open-link, ui/message, ui/request-display-mode,
     * ui/update-model-context, tools/call, resources/read, ping. Opening this
     * with ui/open-link turns a documented navigation into a real save.
     */
    download_url: string | null;
    /**
     * Does the file behind those URLs carry the Vidofy watermark?
     *
     * Stated by the server (`m_watermarked`), not guessed here. The
     * watermarked copy exists only for a B2C row with m_public='on' that is not
     * audio, while a B2B public row is uploaded clean — so a public URL alone
     * does not tell the two apart, and neither does this server's own mode.
     *
     * false when the server does not send the field at all, which is what an
     * older deployment does: the card then simply offers no upgrade button
     * rather than promising to remove a watermark that may not be there.
     */
    watermarked: boolean;
    /**
     * How to feed this result into the NEXT generation.
     *
     * Present so the agent does not download the media and upload it again to
     * chain — the file is already in Vidofy's storage, and the server can
     * point a new job straight at it.
     */
    reuse_as_input: string | null;
}

export function mapResult(payload: unknown): GenerationResult {
    const root = rec(stripProviderCost(payload));
    const data = rec(root['data']);
    const result = rec(data['result']);
    /* Dropped, not overwritten — see the note on GenerationResult. Pulling it
       out of the spread is what makes the key ABSENT rather than present-and-
       null, which is the whole difference the reader notices. */
    const { estimated_seconds: _estimateBelongsToStatusOnly, ...base } = mapStatus(payload);

    const url =
        str(result['output_public_url']) ??
        str(result['m_output_url']) ??
        null;

    return {
        ...base,
        media_type: str(data['media_type']) ?? str(data['m_media_type']),
        url,
        thumbnail_url: str(result['thumbnail_public_url']) ?? str(result['m_thumbnail']),
        dimensions: str(result['output_dimension']) ?? str(result['m_output_dimension']),
        // B2C only — the B2B response shape was deliberately left untouched,
        // so a partner row simply reports null and skips the preview.
        output_size: int(data['m_output_size']),
        download_url: str(data['m_download_url']),
        // === true, so a missing field (older server) or any non-boolean reads
        // false — the card shows no upgrade button rather than a wrong one.
        watermarked: data['m_watermarked'] === true,
        /* Read off the URL, never off the configured mode.
         *
         * Which builder ran is a property of the ROW: the server signs the URL
         * only when the row is first_party AND m_public !== 'on'; a public
         * first-party row and every B2B row get a permanent CDN link
         * instead. So one account-mode token legitimately receives
         * both kinds, and deciding from cfg.mode gets it wrong in both
         * directions — this is the same payload-vs-mode rule that governs
         * mapStatus, applied to the one field that had escaped it.
         *
         * The signature is self-identifying: a presigned link carries
         * X-Amz-Signature in its query string and expires in about 8 hours.
         * No signature, no expiry. */
        url_note: url === null
            ? null
            : /[?&]X-Amz-Signature=/i.test(url)
              ? 'This link is signed and expires in about 8 hours. Call get_result again for a fresh one.'
              : 'This link is a permanent public CDN URL — it does not expire.',
        reuse_as_input: base.done && base.status === 'success' && base.id !== null
            ? `To use this in another generation, pass {"from_generation": "${base.id}"} as the ` +
              'file input — do NOT download this link and upload it again.'
            : null,
    };
}

/* ── cost estimate ───────────────────────────────────────────────────────── */

export class CostUnavailableError extends Error {}

/**
 * Pull the number out of a model-credits response.
 *
 * `cost_credits` is NOT always a number. For a staff account the same endpoint
 * returns an HTML debug string — "Price: <provider cost> USD <br> Coins: <n>" —
 * because the handler enriches it internally. An agent that forwarded that to a user
 * would be quoting HTML as a price, and one that did arithmetic on it would get
 * NaN and silently charge whatever the submit costs.
 *
 * @param unit What the number means in this mode, for the message.
 */
export function readCostCredits(payload: unknown, unit: 'coins' | 'credits'): number {
    const root = rec(payload);
    const raw = root['cost_credits'];

    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

    // A numeric string is fine — some paths JSON-encode it that way.
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
        return Number(raw);
    }

    if (typeof raw === 'string') {
        /* The payload is deliberately NOT quoted here. On a staff account the
           pricing endpoint builds cost_credits as
           "Price: <provider cost> USD <br> Coins: <n>", so echoing it would
           carry the provider cost into an error message that index.ts hands
           straight to the model — the one number this package exists to keep
           in-house, leaking through the guard that was written to catch it. */
        throw new CostUnavailableError(
            'Vidofy returned a price in a debug format instead of a number. ' +
            'This happens on staff accounts. Do not quote a price to the user — ' +
            'generate will still charge the correct amount.'
        );
    }
    throw new CostUnavailableError(
        `Vidofy did not return a price in ${unit}. The model may be unavailable, or a required input is missing.`
    );
}
