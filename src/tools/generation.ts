/**
 * Run a generation, price one first, and read one back.
 *
 * `generate` is the only tool in this package that spends anything. Everything
 * around it is read-only.
 */

import { z } from 'zod';

import type { Config } from '../config.js';
import { log } from '../log.js';
import { request, contentIdempotencyKey, sleep, VidofyError, type FileField } from '../backend.js';
import { buildModelSchema, type ModelSchema } from '../schema.js';
import { mapStatus, mapResult, readCostCredits, stripProviderCost } from '../map/b2c.js';

/** coins on the account door, credits on the key door — the wallets differ. */
const unitFor = (cfg: Config): 'coins' | 'credits' => (cfg.mode === 'account' ? 'coins' : 'credits');

/**
 * Turn the agent's clean-named input into what the wire wants.
 *
 * Shared by estimate_cost and generate deliberately: if the two mapped inputs
 * differently, the quote the user approved would not be the job they paid for.
 *
 * An unrecognised key is an ERROR, not something to drop. Dropping it prices —
 * and then generates — the model's DEFAULTS while the agent believes it asked
 * for something else, which on a model whose price swings 20× with its settings
 * is both the wrong output and the wrong bill, with nothing in either response
 * to say so.
 */
function toWire(
    schema: ModelSchema,
    input: Record<string, unknown> | undefined,
    /* Slot indices already claimed by a reuse reference, keyed by the slot's
     * clean name. A numbered multi-upload slot can hold a MIX — one file from
     * disk and one chained from an earlier generation — and both halves are
     * numbered into the same m_multi_file_<n> namespace. Without this the
     * uploads restart at 0 and overwrite the reuse entries the server was told
     * about, so the job silently runs on the wrong inputs. */
    takenIndices: Record<string, Set<number>> = {}
): { form: Record<string, string>; files: FileField[] } {
    const form: Record<string, string> = {
        m_model_key: schema.model_key,
        m_slug: schema.slug,
        /* Sent for effect models, omitted for the rest.
         *
         * Without it the price handler falls back to a rate that does not match
         * the effect, and the worker dispatches an empty scene, so the user is
         * billed the wrong amount for the wrong output.
         * It rides here rather than in `wire` because it is not a choice the
         * agent makes: it belongs to the model it already picked. */
        ...(schema.effect_key !== '' ? { m_effect_key: schema.effect_key } : {}),
        m_mode: schema.mode_wire,
    };
    const files: FileField[] = [];
    const slots = new Map(schema.files.map((f) => [f.name, f]));
    const unknown: string[] = [];

    for (const [clean, value] of Object.entries(input ?? {})) {
        if (value === undefined || value === null) continue;

        const slot = slots.get(clean);
        if (slot) {
            /* A reuse reference is resolved BEFORE toWire runs (generate does
               it, because it needs a round trip), and estimate_cost now drops
               every file slot before calling here, so no ordinary path reaches
               this branch any more. It stays as a guard: a future caller that
               forgets one of those two steps gets a sentence naming the input
               instead of "[object Object]" arriving at the filesystem. */
            if (isReuseRef(value)) {
                throw new VidofyError(
                    'REUSE_NOT_SUPPORTED_HERE',
                    `"${clean}" was given a from_generation reference, which only generate can resolve. ` +
                        'estimate_cost prices the settings, not the file — omit file inputs when pricing.'
                );
            }

            /* A multi-upload slot's wire name ends in a LITERAL "_N", because
               the server numbers the fields itself: it matches
               ^m_multi_file_\d+$ / ^m_multi_<type>_file_\d+$
               as a pattern. Sent verbatim, the file
               arrives under a field name nothing reads, the count comes to
               zero, and the submit 422s below min_media — every one of the 56
               models with a required multi slot was unusable until 2026-09-07.
               These slots also take SEVERAL files, so the value may be a list. */
            const isNumbered = slot.wire.endsWith('_N');

            /* Check every ELEMENT, not just the value. `String()` on an object
             * yields "[object Object]", which used to travel all the way to
             * the filesystem and surface as
             *   FILE_UNREADABLE: ENOENT ... lstat '[object Object]'
             * — an error that names nothing the caller wrote and leaks an
             * internal call. A reuse reference inside a list is the case that
             * hit it, and generate now lifts those out before this runs, so
             * anything left here is genuinely not a path. */
            const raw = Array.isArray(value) ? value : [value];
            const paths: string[] = raw.map((el, i) => {
                if (typeof el === 'string') return el;
                const where = Array.isArray(value) ? `${clean}[${i}]` : clean;
                throw new VidofyError(
                    'INVALID_FILE_INPUT',
                    `${where} must be a path to a file on this machine, or ` +
                        '{"from_generation": "<id>"} to reuse an earlier generation. ' +
                        `Received ${el === null ? 'null' : typeof el}.`
                );
            });

            if (!isNumbered && paths.length > 1) {
                throw new VidofyError(
                    'TOO_MANY_FILES',
                    `${clean} takes a single file, but ${paths.length} paths were given.`
                );
            }

            /* Number around whatever reuse already claimed, so a mixed list
             * stays collision-free and keeps its order. */
            const taken = takenIndices[clean] ?? new Set<number>();
            let next = 0;
            paths.forEach((p) => {
                while (taken.has(next)) next++;
                const index = next++;
                files.push({
                    field: isNumbered ? slot.wire.replace(/_N$/, `_${index}`) : slot.wire,
                    path: p,
                    // The limits travel with the file so the transport can
                    // refuse a wrong type or an oversized one before reading it.
                    accept: slot.accepts,
                    ...(slot.maxSizeMb !== null ? { maxSizeMb: slot.maxSizeMb } : {}),
                    // The length cap travels with the file for the same reason
                    // the size and type do: so the transport can refuse before
                    // the upload rather than after the server's 422.
                    ...(slot.maxDurationSec !== null ? { maxDurationSec: slot.maxDurationSec } : {}),
                });
            });
            continue;
        }

        const wire = schema.wire[clean];
        if (wire === undefined) {
            unknown.push(clean);
            continue;
        }

        /* A SETTING must be a single scalar, and the check has to be here.
         *
         * This line used to be `String(value)` with no test, and the input
         * schema is `z.record(z.unknown())` — any shape parses — while the
         * required-field check above asks only whether a key is PRESENT. So
         * {"prompt": {"text": "a cat"}} passed every gate and reached the
         * server as m_prompt=[object Object]. Coins are deducted when the
         * submit is accepted, not when it succeeds, so the user paid for a
         * generation on a literal that means nothing. A list is the same
         * failure with a comma: String(["a","b"]) is "a,b".
         *
         * Refused rather than unwrapped. Guessing that {"text": …} meant its
         * .text is how you charge someone for a generation on a value they
         * never wrote — and the file slots above already refuse a non-string
         * for exactly this reason, so this is the same rule applied to the
         * other half of the input.
         *
         * Scalar is the whole legitimate set, measured across the live
         * catalogue rather than assumed: every dynamic field in it is
         * radio_group, select, slider or toggle, and none is multi-valued.
         *
         * Non-finite numbers go with them. NaN is typeof "number" and would
         * slip through a plain typeof test as the string "NaN", which PHP
         * casts to 0 — a slider silently priced and generated at zero is the
         * same defect wearing a different type. */
        const scalar =
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value));
        if (!scalar) {
            const got = Array.isArray(value)
                ? 'a list'
                : typeof value === 'object'
                  ? 'an object'
                  : typeof value === 'number'
                    ? `${value}`
                    : typeof value;
            throw new VidofyError(
                'INVALID_INPUT_VALUE',
                `"${clean}" takes one text, number or true/false value — received ${got}. ` +
                    'Pass the value itself, not a wrapper around it: ' +
                    `{"${clean}": "…"}, not {"${clean}": {"…": "…"}}. ` +
                    'Call get_model for this input\'s type.'
            );
        }
        form[wire] = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    }

    if (unknown.length) {
        const known = [...Object.keys(schema.wire), ...slots.keys()].sort();
        throw new VidofyError(
            'UNKNOWN_INPUT_FIELD',
            `${schema.model_key} has no input called ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
                `Call get_model and use the names in its schema: ${known.join(', ')}.`
        );
    }

    return { form, files };
}

/* ── estimate_cost ───────────────────────────────────────────────────────── */

export const estimateCostInput = z.object({
    model: z.string().min(1).describe('Model slug, as given to get_model.'),
    input: z
        .record(z.unknown())
        .optional()
        .describe(
            'The same input object you would pass to generate. Price varies enormously with ' +
            'it — on some models by 20× between the cheapest and dearest settings — so pass ' +
            'the real values, not an empty object.'
        ),
});

/**
 * Ask the server what a generation would cost, before running it.
 *
 * The price is computed by the same calculator the submit path uses, so this
 * is an answer rather than an estimate — provided the input matches what
 * generate will be given.
 */
export async function estimateCost(
    cfg: Config,
    // `| undefined` spelled out because exactOptionalPropertyTypes distinguishes
    // "absent" from "present and undefined", and zod's .optional() produces the
    // latter.
    args: { model: string; input?: Record<string, unknown> | undefined }
): Promise<unknown> {
    // The wire names live in the model's schema; sending clean names would
    // price the model's defaults instead of what the agent actually chose, and
    // do it silently.
    const info = await request(cfg, {
        method: 'GET',
        path: `info/model-info/${encodeURIComponent(args.model)}`,
    });
    const schema = buildModelSchema(info);

    /* Same mapping generate will use — see toWire — but with the file slots
     * stripped out first.
     *
     * Pricing is computed from the settings (duration, resolution, quality,
     * count), never from the bytes; the endpoint receives no upload and would
     * drop one anyway. Passing them through meant a caller who priced the exact
     * input they were about to generate got REUSE_NOT_SUPPORTED_HERE and the
     * whole call failed, which forced them to build two different input objects
     * for one operation — an easy way to price A and then generate B.
     *
     * Dropped silently and by SLOT NAME, so a path is discarded on the same
     * footing as a reuse reference and neither can reach toWire's file branch. */
    const pricingInput: Record<string, unknown> = { ...(args.input ?? {}) };
    for (const slot of schema.files) delete pricingInput[slot.name];
    const { form } = toWire(schema, pricingInput);

    const payload = await request(cfg, { method: 'POST', path: 'info/model-credits', form });
    const cost = readCostCredits(payload, unitFor(cfg));

    /* On an upload-billed model this figure is a FLOOR, and saying so is the
     * whole point of the field.
     *
     * The block above drops every file slot before pricing, and the pricing
     * endpoint receives no upload and would discard one anyway — but a minority
     * of models are charged by the DURATION of the media the
     * user uploads (the submit path measures it with ffprobe). For those, a
     * settings-only number returned under the name `cost` is a quote that is
     * always too low, told to the user as a price and then contradicted by the
     * charge. The number is still worth returning — it is the settings
     * component, and the agent has nothing else — but not under a name that
     * claims to be the total. */
    const upload = schema.billedByUploadDuration;

    return {
        model: schema.model_key,
        cost: cost,
        unit: unitFor(cfg),
        /* Present either way, and false rather than absent: an agent that has
         * to infer "no news is good news" from a missing key will eventually
         * infer it from a key that went missing for a different reason. */
        cost_is_final: !upload,
        ...(upload ? { depends_on: 'the duration of the media you upload' } : {}),
        note:
            (upload
                ? 'THIS IS A FLOOR, NOT THE PRICE. This model is billed by the duration of ' +
                  'the media you upload, which a quote never sends — the figure above covers ' +
                  'the settings only and the real charge will be higher, in proportion to how ' +
                  'long your file is. Tell the user that before generating. '
                : '') +
            `Charged when the generation is submitted, not when it finishes. ` +
            `Re-check after changing any input — the price depends on all of them.`,
    };
}

/* ── reusing an earlier generation as an input ───────────────────────────── */

/**
 * One entry of `regen_source_map` — the server's own "use this stored object as
 * an input" mechanism, which `/app/v1` has always accepted and this package
 * simply never sent.
 *
 * The submit path decodes the map for EVERY caller and empties it only for an
 * API key — so B2B is the door that cannot do this, not B2C. Ownership is then
 * enforced server-side before anything is used.
 */
interface ReuseEntry {
    key: string;
    kind: 'image' | 'video' | 'audio';
    bucket: 'public' | 'private';
    file_name: string;
}

/** What the agent passes in a file slot instead of a path. */
interface ReuseRef {
    from_generation: string;
}

const isReuseRef = (v: unknown): v is ReuseRef =>
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    typeof (v as Record<string, unknown>)['from_generation'] === 'string';

/**
 * Turn `{from_generation: id}` into the R2 object that generation produced.
 *
 * The raw key is fetched here and never shown to the agent: it asks with an id
 * it already has from get_result, and the key stays inside this package.
 *
 * `bucket` matters. A private first-party output lives in the PRIVATE bucket
 * and comes back as a presigned URL, which is why matching on the URL would
 * fail — the resolver's CDN-prefix test only knows the public domain. The key
 * plus `bucket:'private'` sidesteps that entirely, and the worker resolves it
 * with its own private-URL builder. Nothing is downloaded.
 */
async function resolveReuse(
    cfg: Config,
    ref: ReuseRef,
    want: 'image' | 'video' | 'audio',
    slotName: string,
    budgetMs: number
): Promise<ReuseEntry> {
    const payload = await request(cfg, {
        method: 'GET',
        path: `generate/result/${encodeURIComponent(ref.from_generation)}`,
        allowEnvelopeError: true,
        // Bounded by the caller's remaining budget — see the deadline in
        // generate(). One attempt: a read that is retried three times inside a
        // tool call the client has already abandoned helps nobody.
        timeoutMs: budgetMs,
        maxAttempts: 1,
    });
    const root = (payload ?? {}) as Record<string, unknown>;
    const data = ((root['data'] ?? {}) as Record<string, unknown>);
    const result = ((data['result'] ?? {}) as Record<string, unknown>);

    const column = want === 'video' ? 'm_output_video' : want === 'audio' ? 'm_output_audio' : 'm_output_image';
    const key = typeof result[column] === 'string' ? (result[column] as string).trim() : '';

    if (key === '') {
        const status = typeof data['m_status'] === 'string' ? data['m_status'] : 'unknown';
        throw new VidofyError(
            'REUSE_SOURCE_UNAVAILABLE',
            `Generation ${ref.from_generation} has no ${want} output to reuse for "${slotName}" ` +
                `(its status is "${status}"). Only a finished generation of the right media type can be reused.`
        );
    }

    /* Always the PRIVATE bucket, and the reason is not the one this used to
       give. It read `data['m_public']` and branched on it — but the result
       endpoint emits m_public in NEITHER response shape, so that expression was always
       '' and the branch always took this same side. A test that cannot fail is
       worse than no test: it reads as a rule being applied.

       Private is nonetheless the correct answer for everything an MCP caller
       can reuse. The worker uploads every B2C output to the private bucket
       FIRST and unconditionally, and only then COPIES a watermarked version to
       the public one under the same key,
       so the private object exists for every first-party row whatever m_public
       says. Measured 2026-09-09 against live R2, ranged GET: private present
       for 8/8 rows in each of image/video/audio x public/not-public.

       The one shape with no private copy is a B2B row (m_origin='public_api'),
       which is uploaded public-only. Reusing one would resolve to a key the
       worker cannot fetch. It is reachable in principle — the result endpoint
       scopes by user, not by origin, so an account that uses both the partner API and
       this server could name such an id — and is left as a known gap rather
       than guessed at, because closing it needs the origin in the payload. */
    return {
        key,
        kind: want,
        bucket: 'private',
        file_name: key.split('/').pop() || key,
    };
}

/* ── generate ────────────────────────────────────────────────────────────── */

export const generateInput = z.object({
    model: z.string().min(1).describe('Model slug, as given to list_models / get_model.'),
    input: z
        .record(z.unknown())
        .describe(
            'The model\'s inputs, using the names from get_model. A file input takes EITHER ' +
            'a path to a file on this machine (pass the user\'s own file, never a copy you ' +
            'made), OR — to reuse something Vidofy already made — an object ' +
            '{"from_generation": "<id of an earlier generation>"}. Reuse is the right way to ' +
            'chain: it costs no upload and no download, because the file is already in ' +
            'Vidofy\'s storage. Example: {"image": {"from_generation": "97803476830366548"}}.'
        ),
    /* The description says "on a subscriber account" because on a free one this
       flag decides nothing: the submit handler forces m_public='on' below
       u_pro 2 so that a watermarked copy exists, under the site's own B2C
       watermark policy. Saying "the output stays private" to every caller
       was a promise the server had stopped keeping. */
    public: z
        .boolean()
        .optional()
        .describe(
            'Publish the result to the public Vidofy CDN, permanently. Default false. On a ' +
            'subscriber account false keeps the output private, served through a link that ' +
            'expires. On a free account the result is published and watermarked either way, ' +
            'and this flag changes nothing. Only pass true if the user asked for a public, ' +
            'permanent link.'
        ),
});

/**
 * Submit a generation. THIS SPENDS THE USER'S BALANCE.
 *
 * Charged at submit, not on success — so a job that
 * fails later has still cost coins, refunded idempotently by the server's own
 * failure path, not by anything here. Call estimate_cost first and show the
 * user the number.
 *
 * Returns as soon as the job is queued, with an id to follow. It does not wait:
 * a generation runs from ~30 seconds to several minutes, far past what a tool
 * call should hold open, and the client would time out somewhere unpredictable.
 * The agent polls get_status instead.
 */
/**
 * Has the caller gone away?
 *
 * ⚠ THE ONE RULE ABOUT THIS SIGNAL: check it BEFORE the submit, never wire it
 * INTO the submit.
 *
 * Charging happens server-side the instant PHP accepts the submit. So aborting a
 * submit that is already in flight is the worst available outcome, strictly worse
 * than doing nothing: the charge may already have committed, and by abandoning the
 * response we throw away the media_id — the user pays and we cannot even tell them
 * what was created. Passing `signal` to that request() call would look like the
 * careful thing and would be the harmful thing.
 *
 * Before the submit, nothing has been spent, so stopping is free and saves the
 * whole charge. After it, there is nothing to undo and the generation is not lost:
 * it lands in the user's account and shows up in get_usage and in the studio. It
 * simply does not appear in the chat they walked away from. Do not "fix" that with
 * a refund — the work was done and delivered.
 */
function abandoned(ctx: { signal?: AbortSignal } | undefined): boolean {
    return ctx?.signal?.aborted === true;
}

export async function generate(
    cfg: Config,
    args: { model: string; input: Record<string, unknown>; public?: boolean | undefined },
    ctx?: { signal?: AbortSignal }
): Promise<unknown> {
    /* Checkpoint one, before any work at all.
     *
     * Cheap and rarely useful on its own — a client that has already gone by the
     * time the handler starts is unusual. It is here because the expensive
     * preparation begins on the next line, and the cost of checking is a property
     * read. */
    if (abandoned(ctx)) {
        throw new VidofyError(
            'CALL_ABANDONED',
            'The caller disconnected before this generation started, so it was NOT submitted '
            + 'and nothing was charged.'
        );
    }

    /* ONE budget for the whole tool call, because the client has one.
     *
     * The submit was already capped at 50s/1 attempt against the SDK's 60s
     * DEFAULT_REQUEST_TIMEOUT_MSEC, but the reasoning stopped there and the
     * preparation before it kept the transport defaults: 60s × 4 attempts,
     * plus backoff. So a single slow model-info could run 264s — and with a
     * reuse reference, another 264s on top — inside a call the client
     * abandoned at 60s. Measured against the report of a generate that hung
     * "more than 4 minutes" and ended with the server not responding: that is
     * exactly 4 × 60s + backoff, and the arithmetic is the whole explanation.
     *
     * A deadline fixes it where per-request timeouts cannot: they compose by
     * ADDING, so every new preflight step makes the ceiling worse, while a
     * deadline is the same ceiling no matter how many steps run under it.
     * Each step gets what is left, so the last one to start is the one that
     * fails — and it fails before the client gives up, which is the point:
     * a timeout the client sees is a timeout, and a timeout it does not see
     * is a charge with no receipt. */
    const deadline = Date.now() + 55_000;
    const remainingMs = (): number => Math.max(2_000, deadline - Date.now());

    const info = await request(cfg, {
        method: 'GET',
        path: `info/model-info/${encodeURIComponent(args.model)}`,
        // Cached server-side for 7 days, so 10s is already generous; capped by
        // the deadline as well, for the case where several reuse refs ran first.
        timeoutMs: Math.min(10_000, remainingMs()),
        maxAttempts: 1,
    });
    const schema = buildModelSchema(info);

    /* Pull out the file slots the agent asked to REUSE rather than upload.
     *
     * The natural agent workflow is a chain — make an image, then animate it —
     * and re-uploading is the wrong way to do it: the bytes are already in
     * Vidofy's own R2. `regen_source_map` points the new job at the existing
     * object, so nothing is downloaded, nothing is uploaded, and the server
     * checks ownership before using it.
     *
     * Resolution happens here, not in toWire, because it needs a round trip
     * per reference; what toWire receives afterwards is only local paths. */
    const reuse: Record<string, ReuseEntry> = {};
    const takenIndices: Record<string, Set<number>> = {};
    const inputForWire: Record<string, unknown> = { ...(args.input ?? {}) };
    for (const slot of schema.files) {
        const v = inputForWire[slot.name];
        // The slot decides which of the source's outputs to take: an image
        // slot wants its image, a lipsync video slot wants its video.
        const want: 'image' | 'video' | 'audio' =
            /video/i.test(slot.wire) || /video/i.test(slot.name) ? 'video'
            : /audio/i.test(slot.wire) || /audio/i.test(slot.name) ? 'audio'
            : 'image';

        /* Refuse a chain the SERVER will throw away, before spending on it.
         *
         * supportsReuse was computed and reported by get_model and then never
         * acted on here. The server-side filter that decides matches
         * /^m_multi_file_\d+$/ and an exact allow-list, so
         * a per-type slot — m_multi_image_file_0 and its kin — matches neither
         * and is dropped with a bare `continue`. Nothing is said. The
         * generation then runs without the input the caller asked for, or
         * 422s below min_media after a wasted round trip resolving a reference
         * that was never going to be used.
         *
         * Measured 2026-09-10 over the live catalogue: of the 46 active listed
         * models with multi-upload, 39 use the legacy m_multi_file_N and chain
         * fine; 7 use per-type slots and cannot. It is a server gap — the
         * studio cannot chain those either — so this refuses rather than
         * pretending, and says which slot and what to do instead. */
        if ((isReuseRef(v) || (Array.isArray(v) && v.some(isReuseRef))) && !slot.supportsReuse) {
            throw new VidofyError(
                'REUSE_NOT_SUPPORTED_FOR_SLOT',
                `"${slot.name}" cannot reuse an earlier generation on ${schema.model_key}: the ` +
                    `server discards a chained input for this slot (${slot.wire}), so the job ` +
                    'would run without it. Download the file and pass its path instead, or pick ' +
                    'a model whose get_model shows supportsReuse on this slot.'
            );
        }

        if (isReuseRef(v)) {
            reuse[slot.wire] = await resolveReuse(cfg, v, want, slot.name, Math.min(10_000, remainingMs()));
            delete inputForWire[slot.name];
            continue;
        }

        /* A multi-upload slot takes a LIST, and a chain is the natural way to
         * fill one — "edit the image you just made, plus this photo of mine".
         * Only a bare object was recognised before, so a reference inside the
         * list fell through to the upload path and died on
         * lstat('[object Object]'). Each reference is numbered at the position
         * the caller wrote it, and toWire numbers the remaining files around
         * those, so order survives and nothing collides.
         *
         * Restricted to numbered slots because the wire name is what carries
         * the index; a single-file slot given a list is still an error, and
         * toWire raises it. */
        if (Array.isArray(v) && slot.wire.endsWith('_N') && v.some(isReuseRef)) {
            const taken = new Set<number>();
            const rest: unknown[] = [];
            for (let i = 0; i < v.length; i++) {
                const el = v[i];
                if (isReuseRef(el)) {
                    reuse[slot.wire.replace(/_N$/, `_${i}`)] =
                        await resolveReuse(cfg, el, want, `${slot.name}[${i}]`, Math.min(10_000, remainingMs()));
                    taken.add(i);
                } else {
                    rest.push(el);
                }
            }
            takenIndices[slot.name] = taken;
            if (rest.length) inputForWire[slot.name] = rest;
            else delete inputForWire[slot.name];
        }
    }

    const { form, files } = toWire(schema, inputForWire, takenIndices);

    /* The map is keyed by the WIRE field name, which is exactly what the
       server's own whitelist accepts — m_image / m_video / m_audio /
       m_first_frame / m_last_frame / a dynamic field's own name / and
       m_multi_file_N.

       Known limit, and it is the SERVER's not ours: the per-type multi slots
       (m_multi_<type>_file_N, 7 models) are absent from that whitelist, so
       reuse is silently dropped for them — for the studio too, not just here. */
    if (Object.keys(reuse).length) {
        form['regen_source_map'] = JSON.stringify(reuse);
    }

    /* Refuse locally what the server would refuse anyway.
     *
     * Not a duplicate of the server's validator — it is the same check moved
     * to where the error is readable. The 422 says INVALID_REQUEST with a
     * field list; this says which named input is missing, in the vocabulary
     * get_model just handed the agent, without a round trip. */
    const missing = [
        ...schema.inputSchema.required.filter((r) => !(r in (args.input ?? {}))),
        ...schema.files.filter((f) => f.required && !(f.name in (args.input ?? {}))).map((f) => f.name),
    ];
    if (missing.length) {
        throw new VidofyError(
            'MISSING_REQUIRED_INPUT',
            `${schema.model_key} needs ${missing.map((m) => `"${m}"`).join(', ')}. ` +
                'Call get_model for the full input schema.'
        );
    }

    /* Private by default. The server reads m_public as the literal 'on' — an
       unchecked HTML checkbox sends nothing at all, which is exactly what
       "private" means here, so the key is OMITTED rather than set to a falsy
       value the handler would still see as present. */
    if (args.public === true) form['m_public'] = 'on';

    /* Refuse to submit on a budget too small to hear the answer.
     *
     * Charging happens server-side the moment the submit is accepted, so a
     * POST that starts with two seconds left is the worst possible outcome:
     * the coins go, the answer arrives after the client has stopped listening,
     * and the agent is told the call failed. Better to stop here, where
     * nothing has been spent and the message can say so plainly. */
    if (remainingMs() < 15_000) {
        throw new VidofyError(
            'PREFLIGHT_BUDGET_EXHAUSTED',
            'Preparing this generation (reading the model, resolving the reused inputs) used the ' +
                'whole time budget, so it was NOT submitted and nothing was charged. Retry, or ' +
                'pass fewer from_generation references in one call.'
        );
    }

    /* Checkpoint two — the one that matters, and it belongs exactly here.
     *
     * This is the last instant at which stopping is free: one line below, the POST
     * goes out and the coins are gone. The guard above says the same thing about a
     * spent time budget — "stop here, where nothing has been spent and the message
     * can say so plainly" — and an abandoned call has the identical shape. The
     * preparation that just ran (model-info, resolving every from_generation
     * reference, hashing the payload) takes seconds and is where a user actually
     * walks away, which is what makes this checkpoint the valuable one rather than
     * the first.
     *
     * Measured 2026-09-13: a disconnect reaches this signal 5 ms after the socket
     * dies, so by the time a multi-second preparation finishes, the flag is set. */
    if (abandoned(ctx)) {
        throw new VidofyError(
            'CALL_ABANDONED',
            'The caller disconnected while this generation was being prepared, so it was NOT '
            + 'submitted and nothing was charged.'
        );
    }

    const payload = await request(cfg, {
        method: 'POST',
        path: 'generate/submit',
        form,
        files,
        /* One key per logical generation — and "logical" has to mean the
         * REQUEST, not the invocation.
         *
         * The server dedupes on it — it reads it, checks it, and keys the coin
         * ledger with it — which makes
         * the transport's retries safe. But this was newIdempotencyKey(), a
         * randomUUID() minted fresh on every call, so the tuple the server
         * dedupes on could never repeat and the dedupe could never fire: two
         * identical generate calls were two generations and two charges. Both
         * halves of the mechanism were built; the value joining them
         * guaranteed they would miss.
         *
         * Derived from the model, the resolved inputs and the public flag,
         * inside a 60-second window — see contentIdempotencyKey for why the
         * window is part of the key rather than a nicety (the server's lookup
         * has no time bound of its own).
         *
         * `form` is the right thing to hash rather than args.input: it is what
         * actually goes on the wire, after toWire has resolved reuse
         * references and normalised names, so two spellings of one request
         * agree and two different requests cannot collide. The file PATHS ride
         * separately because their bytes are not in `form`. */
        idempotencyKey: contentIdempotencyKey(form, files.map((f) => f.path)),
        /* Deliberately UNDER the client's own budget, not over it.
         *
         * The SDK gives a tool call 60s by default
         * (shared/protocol.js DEFAULT_REQUEST_TIMEOUT_MSEC = 60000). This
         * used to be 90s, and 300s with files, reasoning that an upload needs
         * room — which had it exactly backwards: the client gives up at 60s
         * while the POST keeps running, the server charges, and the agent is
         * told the call failed and retries with a FRESH idempotency key. That
         * is a double charge produced by the timeout meant to prevent
         * trouble. Whatever budget we take has to end before the client's, so
         * a timeout here is a real timeout and not a lost receipt. */
        // Whatever the preparation left, never more than the original 50s.
        // Guarded above to be at least 15s, so this is never a token amount.
        timeoutMs: Math.min(50_000, remainingMs()),
        // And ONE attempt, for the same reason: 4 × 50s would outlive the
        // client's 60s budget several times over. The server-side dedupe makes
        // a retry harmless; the client giving up mid-charge is what does not.
        maxAttempts: 1,
        /* ⚠ NO `signal` HERE, AND THAT IS THE POINT — see abandoned() above.
           Aborting this request would not stop the charge (PHP commits the moment
           it accepts) and would lose the media_id, so the user would pay for a
           generation nobody can name. The signal is checked BEFORE this line and
           never during it. */
    });

    /* Charged, and the caller is gone. Nothing to undo — the generation is real and
       lands in their account — but it is worth a line in the log, because "a user
       was charged for something they never saw" is the kind of thing that should be
       countable rather than invisible if it turns out to be common. */
    if (abandoned(ctx)) {
        log('generate: the caller disconnected after the submit was accepted — '
            + 'the generation is charged and will complete; it appears in get_usage and the studio.');
    }

    const root = stripProviderCost(payload) as Record<string, unknown>;
    const data = (root['data'] ?? root) as Record<string, unknown>;
    const pick = (...keys: string[]): unknown => {
        for (const k of keys) {
            if (data[k] !== undefined) return data[k];
            if (root[k] !== undefined) return root[k];
        }
        return null;
    };

    const id = pick('media_id', 'id', 'm_id');

    /* No id means we cannot tell the user what they just paid for.
     *
     * The submit answered 200 and the coins are gone, but the response carried
     * no identifier — a shape change, a proxy, a truncated body. Returning
     * `id: null` beside "call get_status with this id" (which is what this did
     * until 2026-09-07) sends the agent to poll `null` and tells the user
     * nothing went wrong. Fail loudly and point at the one place the job can
     * still be found. */
    if (id === null || id === undefined || String(id) === '') {
        throw new VidofyError(
            'SUBMIT_ID_MISSING',
            'Vidofy accepted the generation but returned no id, so it cannot be tracked from here. ' +
                'The balance may already have been charged — call get_usage to find the job before ' +
                'trying again, or a retry will pay for a second one.'
        );
    }

    /* `request_status` is the JOB. `status` is the ENVELOPE, and reading it
     * here was a real bug: a submit answers `status: 'success'` meaning "the
     * request was accepted" while the job it
     * just queued is `request_status: 'processing'` and has not
     * started. Neither shape carries `m_status` on submit — measured — so the
     * old `pick('m_status', 'status', …)` fell through to the envelope every
     * single time and told the agent its generation had SUCCEEDED, one field
     * away from get_status saying 'processing'. An agent that believed it went
     * straight to get_result on an unfinished job.
     *
     * Still read rather than asserted, because 'processing' is not the only
     * honest answer: a duplicate Idempotency-Key replays the original row
     * and reports that row's real state, which may have finished or
     * failed long ago. Hardcoding 'queued' would send the agent to poll
     * something that will never change again. */
    const reported = pick('request_status');
    const status = typeof reported === 'string' && reported !== '' ? reported : 'queued';

    return {
        id,
        status,
        spent: pick('coins_charged', 'credits_charged'),
        unit: unitFor(cfg),
        estimated_seconds: pick('m_sec', 'estimated_seconds'),
        // Also read back, not echoed: the server is what decides, and for a
        // replayed duplicate the answer belongs to the ORIGINAL submit.
        visibility:
            String(pick('m_public') ?? '') === 'on' || args.public === true ? 'public' : 'private',
        model: schema.model_key,
        /* For the card, not for the agent — which is why they are separate
         * fields rather than a nicer `model`.
         *
         * model_key is what chaining and every later call need, so it stays as
         * `model` untouched. But "Flux_schnell_t2i" is a database key wearing a
         * label's clothes, and the card showed it for the whole wait and then
         * swapped to "Flux Schnell" on completion — the same generation
         * appearing to change model. model_name is the name a person reads, and
         * model_icon is the provider's mark, so the card can carry the maker's
         * logo instead of a coloured square. Both come from the schema already
         * in hand; neither costs a request. */
        model_name: schema.name !== '' ? schema.name : schema.model_key,
        model_icon: schema.icon,
        /* 'processing' is what a fresh submit reports, and it has to be in this
         * list: leaving it out sent every new generation down the "already
         * finished" branch. 'queued'/'pending' stay for the fallback above and
         * for any older shape. */
        next:
            status === 'processing' || status === 'queued' || status === 'pending'
                ? 'Charged now, not on success. Call get_status with this id — it is not finished ' +
                  'yet. When done:true, call get_result.'
                : `This id was already submitted before and Vidofy replayed that job, which is ` +
                  `"${status}". Nothing was charged twice. Call get_status to confirm, then get_result.`,
    };
}

/* ── get_status ──────────────────────────────────────────────────────────── */

export const generationIdInput = z.object({
    id: z.string().min(1).describe('The id returned by generate.'),
});

/** get_result takes the same id, plus a way to decline the inline image. */
export const generationResultInput = generationIdInput.extend({
    include_preview: z
        .boolean()
        .optional()
        .describe(
            'Return the media itself as an image, so it appears in the conversation and you can ' +
            'see it. Default true. An image comes back as itself; a video comes back as its ' +
            'poster frame, with the video at url. Pass false when you only need the link — it ' +
            'saves roughly 1,400 tokens.'
        ),
});

/**
 * How long get_status may hold the call open before answering.
 *
 * A model has no way to wait. Told to "poll", with a tool it can call
 * instantly and nothing saying how often, it calls as fast as the loop
 * allows — measured on a real audio run, roughly once a second, each one a
 * paid round trip. The pacing the card uses (poll_after_ms, 3s then 6s) lives
 * on generation_card_state, which is visibility:['app'] and so invisible to
 * the model by design.
 *
 * Holding the call is the half that does not depend on the model's goodwill:
 * one call now covers ten seconds of real time whatever the model intends.
 *
 * Ten seconds, not more, because the host's own tool timeout is variable and
 * outside our control (owner, 2026-09-11) — so this has to be short enough to
 * be safe under the worst of it rather than tuned to any measured value.
 */
const STATUS_HOLD_MS = 10_000;

/** Gap between internal re-reads while holding. */
const STATUS_RECHECK_MS = 2_000;

/**
 * How long the agent should wait before asking again — the advisory half.
 *
 * Built on ELAPSED, deliberately, never on estimated_seconds. The estimate is
 * not reliable enough to schedule against: measured 2026-09-11 over all
 * successful rows, real time runs several times the estimate for images and
 * about double for video, while audio is close. It is not stale data either —
 * the stored estimate is only refreshed for a model with enough recent
 * successes, and almost none qualify. Advising from it would send the agent
 * back early, every time, on exactly the media type that is slowest.
 *
 * The steps come from the real distribution: audio finishes soonest, images
 * next, video last.
 */
function nextCheckIn(elapsedSeconds: number | null): number {
    const e = elapsedSeconds ?? 0;
    if (e < 60) return 5;
    if (e < 180) return 15;
    return 30;
}

export async function getStatus(cfg: Config, args: { id: string }): Promise<unknown> {
    const read = async () =>
        mapStatus(
            await request(cfg, {
                method: 'GET',
                path: `generate/status/${encodeURIComponent(args.id)}`,
                // "Your generation failed" is an ANSWER, not a failed call — the server
                // sends it as 200 + success:false. Let the mapper report it as a
                // terminal status instead of throwing a transport-shaped error.
                allowEnvelopeError: true,
            })
        );

    /* Hold until it finishes or the budget runs out, whichever comes first.
     *
     * Nothing here can finish sooner than this hold anyway: across the
     * successful rows measured, the fastest generation ever recorded took about
     * ten seconds (audio and image; video's floor is far higher), and with the NSFW
     * pre-check enabled the request goes to a moderation model BEFORE the
     * provider is called at all, which only pushes that floor later. So the
     * first answer costs the agent nothing in responsiveness. */
    const until = Date.now() + STATUS_HOLD_MS;
    let status = await read();
    while (!status.done && Date.now() + STATUS_RECHECK_MS <= until) {
        await sleep(STATUS_RECHECK_MS);
        status = await read();
    }

    if (status.done) return status;
    return { ...status, check_again_in_seconds: nextCheckIn(status.elapsed_seconds) };
}

/* ── get_result ──────────────────────────────────────────────────────────── */

/**
 * The ceiling on a WHOLE tool result, text and image together.
 *
 * There are two different limits and picking the wrong one broke this: 5 MB is
 * the cap on a single IMAGE at the API, but the client refuses a TOOL RESULT
 * over 1 MB — "Tool result is too large. Maximum size is 1MB" — and that is the
 * one that applies. It is enforced by the host, not by the SDK, so nothing in
 * this package's types would have caught it.
 *
 * The failure is total, which is what makes it serious: the result is rejected
 * whole, so the caller loses the URL, the id and the status as well as the
 * preview. get_result stops being a way to read anything at all. Measured on
 * two real generations: 553 KB of JPEG came back (721 KB encoded), 1,188 KB of
 * PNG was refused (1,547 KB encoded).
 *
 * 1,000,000 rather than 1,048,576 — the message says "1MB" without saying
 * which, and the few kilobytes are not worth being wrong about.
 */
const MAX_TOOL_RESULT_BYTES = 1_000_000;

/**
 * The biggest SOURCE file worth fetching for an inline preview.
 *
 * base64 inflates by 4/3, so this is the ceiling above less the room the JSON
 * text needs. Checked before the download so an oversized file costs nothing,
 * and checked again exactly after it — an estimate here, arithmetic there.
 */
const MAX_INLINE_BYTES = Math.floor((MAX_TOOL_RESULT_BYTES - 20_000) * 3 / 4);

/**
 * Fetch the bytes for an inline preview.
 *
 * Never throws. A preview is a nicety on top of a result the caller already
 * has; failing the whole tool because a thumbnail would not download turns a
 * successful, PAID generation into an error. Every failure path returns null
 * and the caller reports the reason in words.
 */
async function fetchPreview(
    url: string,
    knownBytes: number | null
): Promise<{ data: string; mimeType: string } | null> {
    // Refuse before spending anything, when the row told us the size.
    if (knownBytes !== null && knownBytes > MAX_INLINE_BYTES) return null;
    try {
        const res = await fetch(url, {
            // Short and single: the media is already reachable by URL, so a
            // slow preview is worth abandoning, never retrying. Same budget
            // discipline as generate() — see the deadline there.
            signal: AbortSignal.timeout(15_000),
            redirect: 'error',
        });
        if (!res.ok) return null;

        /* Second guard, on the header. The row's size can be 0 (never
         * recorded) or stale, and a video POSTER has no stored size at all —
         * measured 7-98 KB, but measured is not guaranteed. Content-Length
         * arrives before the body, so this still costs no transfer. */
        const declared = Number(res.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_INLINE_BYTES) return null;

        const buf = Buffer.from(await res.arrayBuffer());
        // Third guard, for a response that declared nothing.
        if (buf.byteLength > MAX_INLINE_BYTES) return null;

        /* Normalise, do not pass through.
         *
         * R2 serves the posters as `image/jpg`, which is NOT a real media type
         * — the registered one is `image/jpeg`, and `jpg` only ever existed as
         * a filename extension. It comes from the upload path naming the type
         * after the extension. Trusting the header verbatim put an invalid
         * type on the wire, which a client is entitled to reject outright, and
         * it is exactly the kind of thing that fails on someone else's client
         * and not on the one you tested with.
         *
         * An allow-list rather than a rewrite of whatever arrives: only these
         * four are safe to claim, so anything unrecognised falls back to the
         * extension and then to JPEG. */
        const raw = (res.headers.get('content-type')?.split(';')[0] ?? '').trim().toLowerCase();
        const CANON: Record<string, string> = {
            'image/jpeg': 'image/jpeg',
            'image/jpg': 'image/jpeg',
            'image/png': 'image/png',
            'image/webp': 'image/webp',
            'image/gif': 'image/gif',
        };
        const mimeType =
            CANON[raw] ??
            (/\.png(\?|$)/i.test(url) ? 'image/png'
            : /\.webp(\?|$)/i.test(url) ? 'image/webp'
            : /\.gif(\?|$)/i.test(url) ? 'image/gif'
            : 'image/jpeg');

        return { data: buf.toString('base64'), mimeType };
    } catch {
        return null;
    }
}

export async function getResult(
    cfg: Config,
    args: { id: string; include_preview?: boolean | undefined }
): Promise<unknown> {
    const payload = await request(cfg, {
        method: 'GET',
        path: `generate/result/${encodeURIComponent(args.id)}`,
        // Same as get_status — the result endpoint reports a failed job the
        // same way, as a 200 whose envelope says success:false.
        allowEnvelopeError: true,
    });
    // No mode argument: whether the URL expires is a property of the row, and
    // the mapper reads it off the URL itself. See the note in mapResult.
    const mapped = mapResult(payload);

    if (!mapped.done) {
        return {
            ...mapped,
            hint: 'Still running. Call get_status to check, and get_result once it reports done.',
        };
    }

    /* Put the media IN the conversation, not just a link to it.
     *
     * A URL is invisible to the model — it is a string. Without this the agent
     * hands over an address it has never seen, cannot say whether the light is
     * right or which of two takes is better, and reaches for some other tool to
     * look. MCP's image content block is the mechanism, and its `data` field
     * takes base64 bytes only; a URL placed there decodes to noise.
     *
     * The link is NOT replaced. The block is a view; the URL is the file the
     * user keeps, the full resolution, the video itself, and the only thing
     * left when a preview is skipped. */
    if (args.include_preview === false) return mapped;

    const isImage = mapped.media_type === 'image';
    const isVideo = mapped.media_type === 'video';

    /* Video is a link, always: the protocol has no video block. Its POSTER is
     * a separate JPEG of a few tens of KB, so the frame goes inline
     * and the video stays a URL. Audio has neither a poster nor a size that
     * would fit — several MB typical — so it is a link and says so. */
    /* An image now has a poster of its own too (2026-09-11).
     *
     * Until then m_thumbnail WAS the output key for images — identical on every
     * row — so sending "the thumbnail" sent the full file and
     * the block was refused for exceeding the 1 MB tool-result limit on most
     * images. The pipeline now writes a real 768px WebP beside the output;
     * measured on the first real generation through it, 14 KB against 1,514 KB.
     *
     * Compared against the url rather than merely checked for existence,
     * because on every row made BEFORE this the two are still the same string
     * — no backfill was done (owner, 2026-09-11) — and those must keep the old
     * behaviour exactly, size guard included. A row with a real thumbnail
     * skips that guard: output_size describes the full file, which is not
     * what we are fetching. */
    const imageThumb =
        isImage && mapped.thumbnail_url !== null && mapped.thumbnail_url !== mapped.url
            ? mapped.thumbnail_url
            : null;

    const src = isImage ? (imageThumb ?? mapped.url) : isVideo ? mapped.thumbnail_url : null;
    const known = isImage && imageThumb === null ? mapped.output_size : null;

    if (src === null) {
        return {
            ...mapped,
            preview: `No inline preview for ${mapped.media_type ?? 'this media type'} — open the url.`,
        };
    }

    const preview = await fetchPreview(src, known);
    if (preview === null) {
        const tooBig = known !== null && known > MAX_INLINE_BYTES;
        return {
            ...mapped,
            preview: tooBig
                ? `Not shown inline: the file is ${(known / 1_048_576).toFixed(1)} MB, and a tool ` +
                  `result may carry only 1 MB in total once the image is base64-encoded. ` +
                  `Open the url for it — everything else in this result is complete.`
                : 'The inline preview could not be fetched. The result itself is fine — open the url.',
        };
    }

    /* Last guard, and the only exact one: measure the finished result.
     *
     * Everything above is an estimate — a size the row reported, a header the
     * origin declared, a byte count before encoding. This weighs what will
     * actually be sent. It matters because being wrong here is not "no
     * preview", it is the host rejecting the entire result, so the caller
     * loses the URL and the status too and has no idea why. */
    const textBytes = Buffer.byteLength(JSON.stringify(mapped, null, 2), 'utf8');
    if (textBytes + preview.data.length > MAX_TOOL_RESULT_BYTES) {
        return {
            ...mapped,
            preview:
                `Not shown inline: encoded it comes to ${(preview.data.length / 1_048_576).toFixed(1)} MB, ` +
                `over the 1 MB a tool result may carry. The file itself is fine — open the url.`,
        };
    }

    const out: Record<string, unknown> = {
        ...mapped,
        preview: isVideo
            ? 'The image shown is the video POSTER. The video itself is at url.'
            : 'Shown above. url is the same file at full resolution.',
    };
    /* Held beside the result, never on it — see setPreview. The dispatcher
     * reads it back and emits a separate image block. */
    setPreview(out, preview);
    return out;
}

/**
 * Media a tool wants shown, held BESIDE the result rather than on it.
 *
 * This was a Symbol key on the result object, chosen because JSON.stringify
 * skips symbol keys — structural protection instead of a rule to remember. It
 * was also, exactly, a bug: the SDK validates every tool result against
 * CallToolResultSchema, structuredContent is a z.record(z.string(), …), and Zod
 * walks own SYMBOL keys too. So the response was rejected before it left, as
 * `-32602 Invalid tools/call result: expected string, received symbol`, and the
 * host showed "Failed to call tool". Deterministic: every get_result carrying a
 * preview failed and include_preview:false always worked, which is what made it
 * look like a size limit when size had nothing to do with it.
 *
 * A WeakMap has no key on the object at all — nothing to serialise, nothing to
 * validate, nothing to iterate over. It is the primitive this needed from the
 * start. Entries die with the result they belong to.
 */
const previews = new WeakMap<object, { data: string; mimeType: string }>();

/** Attach media to a result. @see takePreview */
export function setPreview(result: object, preview: { data: string; mimeType: string }): void {
    previews.set(result, preview);
}

/** The media attached to a result, if any. Read once by the dispatcher. */
export function takePreview(result: unknown): { data: string; mimeType: string } | null {
    return result !== null && typeof result === 'object' ? previews.get(result) ?? null : null;
}

/* ── the generation card's state (MCP Apps) ──────────────────────────────── */

/**
 * Turn the stored dimension into something a person reads.
 *
 * The column holds JSON — `{"width":1344,"height":768}` — and the card was
 * printing it verbatim, so a finished image was labelled with a fragment of
 * database. Anything unparseable is returned as-is rather than dropped: a
 * value we did not expect is still better shown than hidden.
 */
function readableDimensions(raw: string | null): string | null {
    if (raw === null || raw === '') return null;
    try {
        const d = JSON.parse(raw) as { width?: unknown; height?: unknown };
        const w = Number(d.width);
        const h = Number(d.height);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            // × (U+00D7), not the letter x — this is a dimension, not a variable.
            return `${Math.round(w)} × ${Math.round(h)}`;
        }
    } catch {
        /* not JSON — some rows store "1920x1080" already */
    }
    return raw;
}

/**
 * Seconds as a person reads them: 47s, 3m 54s.
 *
 * One implementation, because the card shows a duration twice — counting up
 * while the job runs, and settled in the footer once it finishes — and two
 * spellings of the same quantity on one card ("190s elapsed" above, "234s"
 * below) look like two different kinds of number.
 */
function prettySeconds(secs: number | null): string | null {
    if (secs === null || !Number.isFinite(secs)) return null;
    const s = Math.max(0, Math.round(secs));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * One reading of a generation, shaped for the card view.
 *
 * Called by the view through the host, never by the model — the tool is
 * registered app-only. So it may be called every few seconds without costing
 * tokens or filling the transcript, and it must stay cheap: one request while
 * the job runs, two once it finishes.
 *
 * Status carries the progress; only a finished job needs the result, and only
 * then does the second call happen.
 */
export async function cardState(cfg: Config, args: { id: string }): Promise<unknown> {
    const status = mapStatus(
        await request(cfg, {
            method: 'GET',
            path: `generate/status/${encodeURIComponent(args.id)}`,
            allowEnvelopeError: true,
            timeoutMs: 12_000,
            maxAttempts: 1,
        })
    );

    if (!status.done) {
        /* Only what is TRUE while a job runs: how long it has been going.
         *
         * The estimate (m_sec) is an average over past runs of this model, not
         * a forecast of this one, and it is wrong in both directions routinely.
         * Two things used to be built on it and both misled:
         *
         *   "about 170s"  — read as a promise. Measured 2026-09-10 on
         *                   veo-3-1-fast-i2v: estimate 170s, real 234s.
         *   a percentage  — elapsed/estimate, clamped to 95. Not "no percentage
         *                   invented" as the old comment claimed: it IS the
         *                   estimate wearing a different hat, so the same run
         *                   sat at 95% for the final minute. A bar that parks
         *                   just short of full is the classic lying bar.
         *
         * Removing the estimate and keeping the bar would have kept the lie and
         * dropped the disclaimer, so both go. The card shows a turning ring and
         * an indeterminate sweep instead — motion says "running" without
         * claiming to know when it ends.
         *
         * A "taking longer than usual" note was kept for a day as a THRESHOLD
         * use of the estimate — the one use that a passing second cannot
         * falsify — and then removed on measurement: it appeared on a large
         * fraction of perfectly successful runs of every media type.
         * Backfilling the estimate from real generations did not
         * rescue it — the rates barely moved — because the fault is
         * definitional, not data. m_sec is a MEAN, and roughly half of all
         * perfectly normal runs exceed their own mean; "unusual" would need a
         * high percentile, which this column is not and never was. A note
         * that fires on the majority of healthy runs is decoration.
         *
         * So the estimate now drives nothing on this card. Elapsed is a fact;
         * it is all the card claims. */
        const elapsed = status.elapsed_seconds;
        const secs = elapsed === null ? null : Math.max(0, Math.round(elapsed));
        const pretty = prettySeconds(secs);
        return {
            id: status.id,
            status: status.status,
            done: false,
            model: status.model,
            // Always null: see above. Kept in the payload because the card's
            // setWaiting still accepts a number, so a real per-stage progress
            // signal — if the pipeline ever reports one — needs no card change.
            progress: null,
            wait_label: pretty !== null ? `${pretty} elapsed` : 'working…',
            // Slower once a job is clearly long, so a four-minute video is not
            // eighty round trips.
            poll_after_ms: (elapsed ?? 0) > 60 ? 6_000 : 3_000,
        };
    }

    if (status.status !== 'success') {
        return {
            id: status.id,
            status: status.status,
            done: true,
            model: status.model,
            error: status.error ?? 'The generation did not finish.',
            /* The server refunds a failed job on its own, idempotently; saying
             * so in the card is the difference between a user who is annoyed
             * and one who thinks they were charged for nothing.
             *
             * But NOT for deleted_media, which is not a failure: that
             * generation delivered, and an operator removed its files
             * afterwards. No coins come back, and telling someone
             * their money was returned when it was not is the one error here
             * that costs trust rather than time.
             *
             * Measured against the coin ledger on first-party rows: over a
             * recent window EVERY blocked, error and failed row carries a
             * refund — so `true` is right for those — while NO deleted_media
             * row ever has. (Older rows show far lower rates because refunds
             * were not ledger-recorded then. Those predate the ledger, not the
             * refund, and a card only ever shows a generation the user just
             * made.) */
            refunded: status.status !== 'deleted_media',
        };
    }

    const result = mapResult(
        await request(cfg, {
            method: 'GET',
            path: `generate/result/${encodeURIComponent(args.id)}`,
            allowEnvelopeError: true,
            timeoutMs: 12_000,
            maxAttempts: 1,
        })
    );

    return {
        id: result.id,
        status: 'success',
        done: true,
        model: result.model,
        media_type: result.media_type,
        url: result.url,
        /* The generation's page on the site — where it can be renamed, shared,
         * published to the feed, or used as the start of another one.
         *
         * Built from the configured base rather than written down, so it points
         * at whichever deployment this server talks to. Reachable by the owner
         * even when the output is private: the view page admits a row that is
         * either public or the caller's own, so a signed-in owner sees their own
         * work and nobody else's. */
        vidofy_url: result.id !== null
            ? `${new URL(cfg.baseUrl).origin}/en/view/${encodeURIComponent(result.id)}`
            : null,
        // For a video this is the poster; for an image the mapper reports the
        // same key as url, which the card simply does not use.
        poster_url: result.thumbnail_url,
        download_url: result.download_url,
        /* The watermark, and where to go to be rid of it.
         *
         * A free account's output is published and watermarked — the submit
         * handler forces m_public='on' below u_pro 2 precisely so a watermarked
         * copy exists, under the site's own B2C watermark policy. A
         * subscriber's stays private and clean.
         *
         * The card offers "Remove watermark" only when the file it is showing
         * actually carries one, so the button never appears over a clean image.
         * pricing_url is null in that case rather than always present: a button
         * cannot be rendered by mistake if there is nowhere for it to go. */
        watermarked: result.watermarked,
        pricing_url: result.watermarked
            ? `${new URL(cfg.baseUrl).origin}/en/pricing`
            : null,
        credits: result.credits_charged,
        dimensions: readableDimensions(result.dimensions),
        /* How long it TOOK to make, not how long the file plays.
         *
         * It is result.elapsed_seconds — submit to final state. The footer
         * printed it bare, as "234s", immediately after "1920 × 1080": one
         * property of the file followed by a number that is not one. An
         * 8-second clip that took 234 seconds therefore advertised itself as
         * nearly four minutes long. Reformatting alone would have deepened
         * that — "3m 54s" reads even more like a running time — so the word
         * comes with it.
         *
         * Sent ready to print: the counter above it is worded on this side
         * too, and a second copy of the formatter in the card would be a
         * second place for the two to drift apart. */
        duration_label: result.elapsed_seconds === null
            ? null
            : `took ${prettySeconds(result.elapsed_seconds)}`,
    };
}

/** Exported for the gate, which asserts nothing costed ever escapes. */
export { stripProviderCost };
