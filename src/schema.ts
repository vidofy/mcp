/**
 * Turn one model's admin-authored `m_options` into a JSON Schema an agent can
 * fill in, plus the wire names needed to actually submit it.
 *
 * This is the widest surface in the package. A human wrote the options for every
 * model in the catalogue, so the rule here is: describe only what the data
 * actually contains, and stay silent rather than invent. A property this file
 * omits costs the agent a feature; a property it invents costs the user a
 * rejected generation they already waited for.
 *
 * SHAPES, MEASURED ACROSS THE WHOLE ACTIVE CATALOGUE — not read off the docs:
 *   m_aspect_ratio        ARRAY   all     (often empty)
 *   m_resolution_quality  ARRAY   all     (often empty)
 *   m_duration            OBJECT  some    KEYS are the durations; each value is
 *                                         the list of resolutions that duration
 *                                         allows ({"5": [], "10": []} = any)
 *   m_output_number       INTEGER all
 *   m_dynamic_fields      ARRAY   all     a long tail of field names
 *   m_multi_upload        OBJECT  all     8 key sets, TWO families (see below)
 *   m_negative_prompt / m_seed / m_generate_audio /
 *   m_camera_fixed / m_enhance_prompt        all BOOLEAN
 *
 * DYNAMIC FIELD TYPES IN USE — only five, though the docs list nine:
 *   radio_group · select · toggle · slider · file_upload_image
 * Unknown types degrade to a string rather than throwing: a model added
 * tomorrow must not break the whole catalogue.
 */

/** Minimal JSON Schema draft-07 subset — everything this file emits. */
export interface JsonSchemaProperty {
    type: 'string' | 'number' | 'integer' | 'boolean';
    description?: string;
    enum?: Array<string | number>;
    default?: string | number | boolean;
    minimum?: number;
    maximum?: number;
    multipleOf?: number;
}

export interface FileInput {
    /** The name the agent uses. */
    name: string;
    /** The multipart field the server reads. */
    wire: string;
    required: boolean;
    accepts: string[];
    maxSizeMb: number | null;
    maxDurationSec: number | null;
    description: string;
    /**
     * Whether this slot accepts `{"from_generation": "<id>"}` instead of a path.
     *
     * Not a property of the slot but of the SERVER: reuse travels in
     * regen_source_map, and the submit path keeps a whitelist of field names it
     * will honour — m_image, m_video,
     * m_audio, m_first_frame, m_last_frame, m_multi_file_N, and any dynamic
     * file field by its own name. A name outside it is dropped in silence, so
     * the job runs with no input and 422s on a slot the agent believes it
     * filled. The per-type multi slots (m_multi_<type>_file_N) are the ones
     * that fall outside, and get_model now says so instead of leaving it to be
     * discovered by spending credits.
     */
    supportsReuse: boolean;
}

export interface ModelSchema {
    model_key: string;
    /**
     * The scene identifier for an effect model, '' for everything else.
     *
     * A large share of the catalogue are effect models, and this is what tells
     * the price handler and the worker WHICH effect. Sent on the wire, never
     * shown as an agent-facing input: it is a property of the model the agent
     * already chose, not a decision it makes.
     */
    effect_key: string;
    slug: string;
    name: string;
    /**
     * Absolute URL of the provider's logo, or '' when the row has none.
     *
     * Served from the site's own origin, not the CDN — the server prefixes the
     * stored relative path with its own origin before returning it. Every
     * active model carries one (measured), so a card can label a generation
     * with the mark of whoever made it instead of a coloured placeholder.
     */
    icon: string;
    /** Short code (t2v) — what the agent sees and what list_models accepts. */
    mode: string;
    /** Long key (text-to-video) — what m_mode means on the wire. Not for display. */
    mode_wire: string;
    media_type: string;
    /**
     * FLOOR, not price: the cheapest this model can cost across every option
     * combination — the "from X credits" badge the website shows on its model
     * picker. It is the model row's `m_coins`, which the server computes by
     * pricing the whole option grid and taking the minimum.
     *
     * The real price of a specific request is routinely a MULTIPLE of it — a
     * high resolution on the same model can cost several times the floor.
     * Named `_from` because the bare word
     * `credits` reads as "the price", and an agent that reports it as one
     * quotes the user a number they will not be charged.
     *
     * Only estimate_cost answers what a given input costs.
     */
    credits_from: number | null;
    estimated_seconds: number | null;
    inputSchema: {
        type: 'object';
        properties: Record<string, JsonSchemaProperty>;
        required: string[];
        additionalProperties: false;
    };
    /** clean name → the m_* form field the server actually reads. */
    wire: Record<string, string>;
    files: FileInput[];
    /**
     * This model is billed by the DURATION OF THE MEDIA THE USER UPLOADS, not
     * by the settings alone.
     *
     * It matters because estimate_cost never sends the file — the pricing
     * endpoint receives no upload and would discard one — so for these models
     * the quote covers the settings and the real charge is higher. Saying so
     * is the difference between a price and a number.
     *
     * Read from m_pricing_mode, which the server DERIVES for this purpose: the
     * model-info endpoint runs the same pricing resolver the
     * submit path uses for its ffprobe gate, and normalises the answer into
     * m_pricing_mode='per_second' whether it came from m_pricing_rules or the
     * legacy m_options gate. So one field covers both, and it cannot drift
     * from what is actually charged.
     *
     * Measured over the whole active catalogue: the field a client sees agrees
     * with the resolver everywhere. A minority are upload-billed, and some of
     * those are invisible in the raw m_options — reading the raw option blob
     * instead of the served field would have been silently wrong for them.
     */
    billedByUploadDuration: boolean;
    /** Things the agent must know that a schema cannot express. */
    notes: string[];
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const asRecord = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const isTrue = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
};

/**
 * Clean names for wire fields whose obvious de-prefixing would be wrong or
 * inconsistent.
 *
 * EMPTY, and that is the finished state rather than a stub.
 *
 * It held one entry — `m_resolution_quality: 'resolution'` — placed there for a
 * good reason: that field reaches the schema by TWO routes (the base
 * `m_resolution_quality` array, and on other models a dynamic field of the same
 * name), and without the table the same input would have been called
 * `resolution` on one model and `resolution_quality` on the next. One name for
 * one input was right.
 *
 * The name it chose was not. `m_resolution` is a DIFFERENT wire field, carried
 * by video models as a per-duration list, and it also claimed `resolution` — so
 * two distinct fields shared one clean name, and `wire[]` kept only whichever
 * registered last. Harmless while no model needed both, which was measured and
 * true; `test-i2i` then carried both and the agent lost the ability to send a
 * field the validator demands (gate: SERVER_REQUIRES_MISSING_FIELD, 2026-09-12).
 *
 * Nothing aliases the two for us. The server DOES alias them — but only on a
 * JSON body, and account mode submits multipart, where the only
 * canonicalisation is stripping a "p" suffix. The partner reference says it
 * outright:
 * "a multipart submit that sends only m_resolution to a model requiring it gets
 * a 422 listing m_resolution_quality as missing."
 *
 * So each field now keeps its own de-prefixed name — `resolution_quality` and
 * `resolution` — which is also the pair /api/v1 documents, so MCP and the
 * Partners API say the same words. Collision is gone by construction, and the
 * both-routes consistency the table existed for still holds, because plain
 * de-prefixing gives both routes the same answer.
 *
 * Add an entry here only for a field whose de-prefixed name would be WRONG,
 * never to merge two fields into one name.
 */
const CLEAN_NAME: Record<string, string> = {};

const cleanNameFor = (wireName: string): string =>
    CLEAN_NAME[wireName] ?? wireName.replace(/^m_/, '');

/**
 * The server's own fallback when a model declares no upload limits.
 *
 * Mirrors the server's own hardcoded upload defaults, whose rule is that an
 * empty declared list falls back to them — an empty list means "use the
 * defaults", NEVER "allow anything".
 *
 * This package used to read the declared list and, when it was empty, emit
 * `accepts: []`, which the transport read as "no allowlist to enforce". That is
 * fail-OPEN where the server fails closed, and it was not hypothetical: 10+
 * active, popular models (nano-banana-i2i, gpt-image-1-5-edit-i2i,
 * seedream-4-5-edit-i2i, wan-2-6-r2v …) ship a multi-upload slot with no
 * extensions declared. On those, an agent talked into passing a path to an SSH
 * key or a .env would have had it read and uploaded — measured 2026-09-07,
 * `wallet.pem` went through untouched.
 */
const UPLOAD_DEFAULTS: Record<string, { accepts: string[]; maxSizeMb: number }> = {
    image: { accepts: ['jpg', 'jpeg', 'png', 'webp'], maxSizeMb: 10 },
    video: { accepts: ['mp4', 'mov'], maxSizeMb: 50 },
    audio: { accepts: ['mp3', 'wav'], maxSizeMb: 25 },
};

/**
 * Resolve one slot's real limits, the way the server resolves them.
 *
 * `kind` is image/video/audio; anything else falls back to image, matching the
 * server's own defaults table and its image fallback.
 */
function resolveUploadRules(
    declaredExts: unknown,
    declaredMax: unknown,
    kind: string
): { accepts: string[]; maxSizeMb: number } {
    const d = UPLOAD_DEFAULTS[kind] ?? UPLOAD_DEFAULTS['image']!;
    const exts = asArray(declaredExts)
        // CSV-in-array is real legacy data — the server's own normaliser
        // handles 'jpg,png' and ['jpg,png'] as well as a proper array.
        .flatMap((v) => String(v).split(','))
        .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
        .filter((s) => s !== '');
    const max = num(declaredMax);
    return {
        accepts: exts.length ? exts : d.accepts,
        maxSizeMb: max !== null && max > 0 ? max : d.maxSizeMb,
    };
}

/** Descriptions are admin-authored and contain markup like `<br>`. */
const plain = (v: unknown): string =>
    String(v ?? '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

/* ── the builder ─────────────────────────────────────────────────────────── */

/**
 * @param payload The whole `/info/model-info/{slug}` body. The B2C door wraps
 *   the model under `.model` with m_-prefixed keys; the B2B door returns the
 *   options flat and unprefixed. Both are accepted, and which one arrived is
 *   decided by the PAYLOAD, never by the configured mode — a status lookup can
 *   legitimately return the other shape.
 */
export function buildModelSchema(payload: unknown): ModelSchema {
    const root = asRecord(payload);
    const wrapped = asRecord(root['model']);
    const isWrapped = Object.keys(wrapped).length > 0;
    const model = isWrapped ? wrapped : root;

    /** Read a model field under either naming. */
    const mf = (key: string): unknown => model[`m_${key}`] ?? model[key];

    const opts = asRecord(mf('options'));
    /** Read an option under either naming. */
    const opt = (key: string): unknown => opts[`m_${key}`] ?? opts[key];

    const properties: Record<string, JsonSchemaProperty> = {};
    const required: string[] = [];
    const wire: Record<string, string> = {};
    /* supportsReuse is derived from the finished list, not set at each of the
     * five push sites — see the block just above the return. */
    const files: Omit<FileInput, 'supportsReuse'>[] = [];
    const notes: string[] = [];

    /* Admin defaults — the reason a "required" field often is not.
     *
     * The server applies model defaults BEFORE
     * every required check, filling any listed field that arrives absent or
     * empty from `m_options.m_defaults`. So a
     * field with a non-empty default can never be missing by the time the check
     * runs — marking it required in the schema is stricter than the server and
     * makes the agent supply something it did not need to.
     *
     * 72 model/field pairs carry one today (60 resolution, 4 output_format,
     * 4 style, 4 movement_amplitude), and this was missed when those four
     * fields were made required. It also inflated the figure quoted that day:
     * the count of models missing one of those four fields included many that
     * carried a default the server would have filled, so the number that could
     * actually never generate was far smaller. */
    const modelDefaults = asRecord(opt('defaults'));
    const defaultFor = (wireName: string): string => {
        const v = modelDefaults[wireName];
        return v === undefined || v === null ? '' : String(v);
    };

    const add = (name: string, wireName: string, prop: JsonSchemaProperty, isRequired = false): void => {
        /* Two wire fields may never share one clean name.
         *
         * `wire[name] = wireName` below is a plain assignment, so a second
         * registration under the same name used to overwrite the first and take
         * the losing field out of the map entirely. Nothing failed at that
         * moment: the schema still validated, the tool still answered, and the
         * only symptom arrived later as a 422 from the server naming a field the
         * agent was never told about.
         *
         * It happened. `resolution` was issued to both m_resolution_quality and
         * m_resolution, safe only because no model populated both — measured,
         * documented in a comment, and then falsified by a single row.
         *
         * So the invariant is enforced here instead of being asserted in prose.
         * Throwing is the right answer rather than renaming silently: a
         * duplicate means two inputs were given one identity, and which of them
         * the agent should send is a decision for whoever added the second, not
         * a default this helper can guess. get_model surfaces the throw as an
         * error on that model alone, which is loud, local, and impossible to
         * ship unnoticed — the gate builds a schema for every active model. */
        if (wire[name] !== undefined && wire[name] !== wireName) {
            throw new Error(
                `schema: clean name "${name}" is already mapped to "${wire[name]}" and cannot ` +
                `also carry "${wireName}" — give one of them its own name (see CLEAN_NAME).`
            );
        }
        const dflt = defaultFor(wireName);
        // Surface the default so the agent can send it deliberately, and drop
        // the required flag when one exists — the server will fill it anyway.
        // Only a string default is copied in, and only when the property has
        // none of its own. exactOptionalPropertyTypes forbids spreading a
        // possibly-undefined `default` back over the object.
        properties[name] =
            dflt !== '' && prop.default === undefined && prop.type === 'string'
                ? { ...prop, default: dflt }
                : prop;
        wire[name] = wireName;
        if (isRequired && dflt === '') required.push(name);
    };

    /* ── prompt ──────────────────────────────────────────────────────────
       Required exactly when the shared validator requires it:
       m_active_prompt is on AND m_prompt_settings.required is not false.
       Mirrored from the server's shared validator rather than guessed — this is
       the single most common reason a submit is refused. */
    const promptSettings = asRecord(opt('prompt_settings'));
    if (isTrue(opt('active_prompt'))) {
        const maxChars = num(promptSettings['max_chars']);
        add(
            'prompt',
            'm_prompt',
            {
                type: 'string',
                description:
                    plain(promptSettings['description']) ||
                    plain(promptSettings['placeholder']) ||
                    'What to generate.',
            },
            promptSettings['required'] !== false
        );
        // Carried as a note, not a schema keyword: `maximum` constrains numbers,
        // and the length keyword this subset does not model is `maxLength`. A
        // note the agent reads beats a keyword that would silently do nothing.
        if (maxChars) notes.push(`prompt is limited to ${maxChars} characters`);
    }

    if (isTrue(opt('negative_prompt'))) {
        add('negative_prompt', 'm_negative_prompt', {
            type: 'string',
            description: 'What to avoid in the output.',
        });
    }

    /* ── choice lists ────────────────────────────────────────────────────
       Emitted only when non-empty. An empty array means the model does not
       offer the choice at all, and advertising it would invite a rejected
       value.

       AND A NON-EMPTY LIST MEANS THE FIELD IS REQUIRED. That is not an
       inference — the validator tests "set, an array, and not empty" and then
       rejects the request when the
       value is absent, and the pricing endpoint runs the same validator. An
       earlier version of this file emitted these as optional, which would have
       made every generate fail on the large majority of models, which carry at
       least one enum; the gate caught it as MISSING_REQUIRED_FIELDS. */
    const aspect = asArray(opt('aspect_ratio')).map(String).filter((s) => s !== '');
    if (aspect.length) {
        add('aspect_ratio', 'm_aspect_ratio', { type: 'string', enum: aspect, description: 'Output shape.' }, true);
    }

    /* IMAGE resolution. Measured 2026-09-12: 24 active listed models carry a
       non-empty list here and every one of them is an image — values read
       "1K"/"2K"/"4K", not "720"/"1080". The video counterpart is m_resolution
       below, a separate wire field; see the CLEAN_NAME note for why they must
       not share a clean name. */
    const resolution = asArray(opt('resolution_quality')).map(String).filter((s) => s !== '');
    if (resolution.length) {
        add('resolution_quality', 'm_resolution_quality', {
            type: 'string',
            enum: resolution,
            description: 'Output resolution.',
        }, true);
    }

    /* Duration is an OBJECT whose KEYS are the allowed durations; each value
       lists the resolutions that duration permits (empty = all). The pairing
       is enforced server-side, so the schema offers the durations and says so
       rather than trying to express a cross-field rule JSON Schema cannot. */
    const durations = Object.keys(asRecord(opt('duration')));
    if (durations.length) {
        // Required for the same reason as the two above: a populated list is a
        // choice the validator insists on.
        add('duration', 'm_duration', {
            type: 'string',
            enum: durations,
            description: 'Length in seconds.',
        }, true);
        /* Collapse when every duration allows the same resolutions, which is the
           common case. Spelling out "3s → 720/1080, 4s → 720/1080, …" eight
           times says the same thing eight times and buries the models where the
           pairing genuinely differs. */
        const pairs = Object.entries(asRecord(opt('duration')))
            .map(([d, v]) => [d, asArray(v).map(String).filter((s) => s !== '')] as const)
            .filter(([, v]) => v.length > 0);
        if (pairs.length) {
            /* m_resolution is REQUIRED here, and it is a separate wire field
               from m_resolution_quality above.
               The validator looks up the chosen
               duration's list and rejects the submit when the list is
               non-empty and m_resolution is absent.

               This block used to emit the note alone. That produced a schema
               that contradicted itself — the note told the agent resolution
               had to be 720 or 1080, while additionalProperties:false forbade
               sending it — and every generate on such a model 422'd. It
               affected roughly half the catalogue. Nothing caught it because
               schema.test.mjs only checks the schema against itself, never
               against what the server requires.

               The enum is the union across durations; which subset applies to
               the chosen duration is a cross-field rule JSON Schema cannot
               express, so the note carries it.

               This block used to say reusing the clean name `resolution` was
               "safe: measured, zero models carry both a populated
               m_resolution_quality and a populated per-duration list". The
               measurement was true and the conclusion was still wrong — one row
               is all it takes to end it, and `test-i2i` was that row. The name
               is no longer shared (see CLEAN_NAME), and add() now refuses a
               duplicate outright, so this no longer rests on a count. */
            const union = [...new Set(pairs.flatMap(([, v]) => v))];
            const distinct = new Set(pairs.map(([, v]) => v.join('/')));
            const uniform = distinct.size === 1 && pairs.length === durations.length;

            /* The enum is the UNION across durations, which on a non-uniform
               model offers a value the chosen duration forbids. JSON Schema
               draft-07 cannot express the dependency in a way clients reliably
               honour, so the pairing goes in the property's OWN description —
               the text the agent reads while filling this exact field —
               instead of only in `notes`, which it may never reach.
               Measured 2026-09-07: 55 models pair differently per duration. */
            const pairing = pairs.map(([d, v]) => `${d}s → ${v.join('/')}`).join(', ');
            add('resolution', 'm_resolution', {
                type: 'string',
                enum: union,
                description: uniform
                    ? 'Output resolution.'
                    : `Output resolution. NOT every value is valid at every duration — ${pairing}. ` +
                      'Pick the one that matches the duration you chose, or the submit is refused.',
            }, true);

            notes.push(
                uniform
                    ? `resolution must be one of ${[...distinct][0]} at any duration`
                    : `resolution depends on the duration you pick: ${pairing}`
            );
        }
    }

    /* The remaining three fixed lists, each enforced by the same
       `isset && is_array && count > 0` → required rule as aspect_ratio:
         m_output_format       68 models
         m_movement_amplitude  13 models
         m_style                9 models
       All three were missing until 2026-09-07. */
    const formats = [
        ...new Set(
            // Keyed by media type ("image": ["jpeg","png"]); the validator
            // flattens across every type and de-duplicates, so the
            // agent is offered the same flat set the server will compare against.
            Object.values(asRecord(opt('output_format')))
                .flatMap((v) => asArray(v).map(String))
                .filter((s) => s.trim() !== '')
        ),
    ];
    if (formats.length) {
        add('output_format', 'm_output_format', {
            type: 'string',
            enum: formats,
            description: 'File format of the output.',
        }, true);
    }

    const amplitude = asArray(opt('movement_amplitude')).map(String).filter((s) => s !== '');
    if (amplitude.length) {
        add('movement_amplitude', 'm_movement_amplitude', {
            type: 'string',
            enum: amplitude,
            description: 'How much motion to apply.',
        }, true);
    }

    const style = asArray(opt('style')).map(String).filter((s) => s !== '');
    if (style.length) {
        add('style', 'm_style', {
            type: 'string',
            enum: style,
            description: 'Visual style of the output.',
        }, true);
    }

    const outputNumber = num(opt('output_number')) ?? 1;
    if (outputNumber > 1) {
        add('output_number', 'm_output_number', {
            type: 'integer',
            minimum: 1,
            maximum: outputNumber,
            default: 1,
            description: `How many outputs to generate (up to ${outputNumber}). Each one is charged.`,
        });
    }

    /* ── the boolean switches ────────────────────────────────────────────
       The option is a CAPABILITY flag ("this model can do it"), and the input
       it unlocks is what goes in the schema. m_seed is the odd one: the flag
       is boolean but the value the server wants is a number. */
    for (const [flag, name, wireName, description] of [
        ['generate_audio', 'generate_audio', 'm_generate_audio', 'Generate an audio track with the video.'],
        ['generate_sound_effect', 'generate_sound_effect', 'm_generate_sound_effect', 'Add sound effects.'],
        ['camera_fixed', 'camera_fixed', 'm_camera_fixed', 'Keep the camera still.'],
        ['enhance_prompt', 'enhance_prompt', 'm_enhance_prompt', 'Let the provider rewrite the prompt for better results.'],
    ] as const) {
        if (isTrue(opt(flag))) {
            add(name, wireName, { type: 'boolean', description });
        }
    }
    if (isTrue(opt('seed'))) {
        add('seed', 'm_seed', {
            type: 'integer',
            description: 'Seed for a reproducible result. Omit for a random one.',
        });
    }

    /* ── dynamic fields ──────────────────────────────────────────────────
       Per-model, admin-defined, open-ended by design. Their `name` is already
       the wire name (it must match ^m_[A-Za-z0-9_]{1,64}$ server-side), so the
       clean name is that with the m_ removed. */
    for (const raw of asArray(opt('dynamic_fields'))) {
        const f = asRecord(raw);
        const wireName = String(f['name'] ?? '');
        if (!/^m_[A-Za-z0-9_]{1,64}$/.test(wireName)) continue;   // not a field the server would accept
        const cleanName = cleanNameFor(wireName);
        if (properties[cleanName]) continue;                       // a base field already claimed it

        const type = String(f['type'] ?? '');
        const label = plain(f['label']) || cleanName;
        const description = [label, plain(f['description'])].filter(Boolean).join(' — ');
        const isRequired = f['required'] === true;

        /* is_label options are GROUP HEADERS in the UI, not values. 19 of them
           exist in the catalogue; letting one into an enum would offer the
           agent a choice the server refuses. */
        const choices = asArray(f['options'])
            .map(asRecord)
            .filter((o) => !isTrue(o['is_label']))
            .map((o) => String(o['value'] ?? ''))
            .filter((s) => s !== '');

        if (type === 'file_upload_image' || type === 'file_upload_video' || type === 'file_upload_audio') {
            files.push({
                name: cleanName,
                wire: wireName,
                required: isRequired,
                ...resolveUploadRules(f['value'], f['max_size'], type.replace('file_upload_', '')),
                maxDurationSec: null,
                description,
            });
            continue;
        }

        if (type === 'toggle' || type === 'checkbox') {
            const prop: JsonSchemaProperty = { type: 'boolean', description };
            if (f['default'] !== undefined && f['default'] !== '') prop.default = isTrue(f['default']);
            add(cleanName, wireName, prop, isRequired);
            continue;
        }

        if (type === 'slider') {
            const prop: JsonSchemaProperty = { type: 'number', description };
            const min = num(f['min']); const max = num(f['max']); const step = num(f['step']);
            if (min !== null) prop.minimum = min;
            if (max !== null) prop.maximum = max;
            if (step !== null && step > 0) prop.multipleOf = step;
            const dflt = num(f['default']);
            if (dflt !== null) prop.default = dflt;
            add(cleanName, wireName, prop, isRequired);
            continue;
        }

        // select · radio_group · text · textarea · and anything added tomorrow.
        const prop: JsonSchemaProperty = { type: 'string', description };
        if (choices.length) prop.enum = choices;
        const dflt = f['default'];
        if (dflt !== undefined && dflt !== '' && (!choices.length || choices.includes(String(dflt)))) {
            prop.default = String(dflt);
        }
        add(cleanName, wireName, prop, isRequired);
    }

    /* ── single-file inputs ──────────────────────────────────────────────── */
    for (const [flag, name, wireName, settingsKey] of [
        ['upload_image', 'image', 'm_image', 'upload_image_settings'],
        ['upload_video', 'video', 'm_video', 'upload_video_settings'],
        ['upload_audio', 'audio', 'm_audio', 'upload_audio_settings'],
    ] as const) {
        if (!isTrue(opt(flag))) continue;
        const s = asRecord(opt(settingsKey));
        files.push({
            name,
            wire: wireName,
            required: true,   // the model asked for this input; it is not optional
            ...resolveUploadRules(s['allowed_extensions'], s['max_size'], name),
            maxDurationSec: num(opt(`max_duration_${name}`)),
            description: plain(s['label']) || `The ${name} to work from.`,
        });
    }

    if (isTrue(opt('upload_frames'))) {
        const fs = asRecord(opt('upload_frames_settings'));
        for (const slot of ['first_frame', 'last_frame'] as const) {
            const s = asRecord(fs[slot]);
            files.push({
                name: slot,
                wire: `m_${slot}`,
                required: true,
                // A frame slot is always an image.
                ...resolveUploadRules(s['allowed_extensions'], s['max_size'], 'image'),
                maxDurationSec: null,
                description: plain(s['label']) || `The ${slot.replace('_', ' ')}.`,
            });
        }
    }

    /* ── multi-upload: two families, DIFFERENT field names ───────────────
       A `slots` model REJECTS the legacy name outright, so getting this wrong is not a
       degraded experience, it is a hard refusal. */
    const multi = asRecord(opt('multi_upload'));
    if (isTrue(multi['active'])) {
        const slots = asRecord(multi['slots']);
        if (Object.keys(slots).length > 0) {
            for (const [slotType, rawSlot] of Object.entries(slots)) {
                const s = asRecord(rawSlot);
                const count = num(s['number']) ?? 0;
                const minMedia = num(s['min_media']) ?? 0;
                if (count <= 0) continue;
                files.push({
                    name: `${slotType}_files`,
                    wire: `m_multi_${slotType}_file_N`,
                    required: minMedia > 0,
                    ...resolveUploadRules(s['allowed_extensions'], s['max_size'], slotType),
                    maxDurationSec: num(s['max_duration']),
                    description:
                        `${plain(s['label']) || `${slotType} files`} — up to ${count}` +
                        (minMedia > 0 ? `, at least ${minMedia} required` : '') +
                        `. Numbered from 0: m_multi_${slotType}_file_0, _1, …`,
                });
            }
            notes.push('this model uses PER-TYPE upload fields (m_multi_<type>_file_N); the plain m_multi_file_N is refused');
        } else {
            const slotType = String(multi['type'] ?? 'image');
            const count = num(multi['number']) ?? 0;
            const minMedia = num(multi['min_media']) ?? 0;
            if (count > 0) {
                files.push({
                    name: `${slotType}_files`,
                    wire: 'm_multi_file_N',
                    required: minMedia > 0,
                    ...resolveUploadRules(multi['allowed_extensions'], multi['max_size'], slotType),
                    maxDurationSec: num(multi['max_duration']),
                    description:
                        `Up to ${count} ${slotType} files` +
                        (minMedia > 0 ? `, at least ${minMedia} required` : '') +
                        '. Numbered from 0: m_multi_file_0, _1, …',
                });
            }
        }
        if (isTrue(multi['paid_uploads'])) {
            const free = num(multi['free_count']) ?? 0;
            notes.push(`files beyond the first ${free} are charged extra — call estimate_cost with the real count`);
        }
    }

    /* See ModelSchema.billedByUploadDuration for where this value comes from
     * and why the served field is the right source rather than the column. */
    const billedByUploadDuration = String(opt('pricing_mode') ?? '') === 'per_second';
    if (billedByUploadDuration) {
        notes.push(
            'billed by the DURATION of the media you upload — estimate_cost prices the ' +
            'settings only, so the real charge is higher than its figure'
        );
    }

    /* Mark which slots can be chained, derived once from the wire name rather
     * than repeated at each of the five construction sites above.
     *
     * The list is the server's, copied from the allow-list the submit path
     * applies to a reuse map: the fixed
     * image/video/audio slots under either spelling, the two frame slots,
     * m_multi_file_<n>, and every dynamic file field by its own name. A field
     * outside it is dropped from regen_source_map without a word, so the job
     * runs with that input missing.
     *
     * m_multi_<type>_file_N is the notable exclusion — a server-side gap, not a
     * client one; the studio cannot chain those slots either. Saying so here
     * turns a wasted submit into a readable capability flag. */
    const REUSABLE_FIXED = new Set([
        'm_image', 'm_input_image',
        'm_video', 'm_input_video',
        'm_audio', 'm_input_audio',
        'm_first_frame', 'm_last_frame',
    ]);
    const filesOut: FileInput[] = files.map((f) => ({
        ...f,
        /* Say the length cap out loud.
         *
         * Nine models cap what you may upload, and the admin's label is all
         * the agent used to get — "Video:" on kling-lipsync, which caps video
         * at 30 seconds. Worse on exactly those models: they are the
         * upload-billed ones, so the agent is told "you are billed by the
         * duration of the media you upload" and never told where the ceiling
         * is. Now it can pick a clip that fits, and tell the user the limit
         * before asking them for a file.
         *
         * Appended here rather than at each of the four places a slot is
         * built, so a fifth cannot be added without it. */
        description: f.maxDurationSec !== null && f.maxDurationSec > 0
            ? `${f.description} Up to ${f.maxDurationSec} seconds.`
            : f.description,
        supportsReuse:
            REUSABLE_FIXED.has(f.wire) ||
            f.wire === 'm_multi_file_N' ||
            // A dynamic file field is whitelisted under its own name, and its
            // wire IS that name — any m_* field that is neither a fixed slot
            // nor one of the numbered multi families.
            (/^m_[a-z0-9_]+$/i.test(f.wire) && !/^m_multi_/.test(f.wire)),
    }));

    return {
        model_key: String(mf('model_key') ?? ''),
        effect_key: String(mf('effect_key') ?? ''),
        slug: String(mf('slug') ?? root['slug'] ?? ''),
        name: String(mf('name') ?? ''),
        icon: String(mf('icon') ?? ''),
        /* TWO mode values, because the agent and the wire want different ones
         * and conflating them breaks one of the two.
         *
         * `mode` — the SHORT code (t2v), which is what the agent sees and what
         * list_models accepts. Measured 2026-09-07: /info/models-flat/t2v
         * answers, /info/models-flat/text-to-video is INVALID_MODE. This field
         * used to carry the long key, so an agent that took `mode` out of
         * get_model and passed it to list_models got an error, while the same
         * field name coming from list_modes worked.
         *
         * `mode_wire` — the LONG key (text-to-video), which is what m_mode
         * means on submit and model-credits, and what the media row stores.
         * Never show this to the agent; never post the other one. */
        mode: String(root['mode_code'] ?? mf('mode_code') ?? ''),
        mode_wire: String(mf('mode') ?? root['mode'] ?? ''),
        media_type: String(mf('media_type') ?? ''),
        credits_from: num(mf('coins')) ?? num(mf('credits')),
        estimated_seconds: num(mf('sec')) ?? num(mf('estimated_seconds')),
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        wire,
        files: filesOut,
        billedByUploadDuration,
        notes,
    };
}
