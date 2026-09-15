#!/usr/bin/env node
/**
 * @vidofy/mcp — the Vidofy MCP server.
 *
 * Lets a desktop AI client (Claude Desktop, Cursor, …) generate media with
 * Vidofy, billed to the user's own account. Runs locally over stdio; the
 * client launches it, so nothing here listens on a port.
 *
 * Nine tools: list_modes → list_models → get_model to choose, estimate_cost to
 * price it, generate to run it, get_status and get_result to follow it, plus
 * get_balance and get_usage.
 *
 * Eight of the nine are read-only. `generate` is the only one that spends the
 * user's balance, and it is the only one whose annotations say so — which is
 * what a client reads to decide whether to ask the user first.
 *
 * `upload_file` is deliberately absent: /app/v1 has no upload route at all
 * (it is /api/v1 + an API key only), so on the account door files travel
 * multipart with the submit itself, exactly as the studio posts them. It was
 * planned as a key-mode tool; key mode is not served (see the refusal below),
 * so nothing would ever call it. Nine tools is the whole set, not nine of ten.
 *
 * WHY stdout IS OFF LIMITS
 * ------------------------
 * stdio transport means stdout IS the protocol channel — one stray
 * console.log() writes a non-JSON-RPC line into the stream and the client
 * drops the connection with an error that names nothing. Every diagnostic in
 * this package goes to stderr, which the client shows in its logs and ignores
 * otherwise. There is a `log()` helper below; use it and never console.log.
 */

/* @modelcontextprotocol/server v2, not @modelcontextprotocol/sdk v1.
 *
 * A DIFFERENT npm name for the same project's next major version, which is the
 * detail that cost a day: `npm view @modelcontextprotocol/sdk` reports 1.30.0 with
 * no prerelease, so the conclusion "nothing implements 2026-07-28 yet" looked
 * measured and was an artefact of searching one name.
 *
 * What the move buys is one thing, and it is the reason the card was missing on
 * claude.ai: in the 2026-07-28 revision the client's capabilities travel in `_meta`
 * on EVERY request instead of once at initialize, so a STATELESS server — which is
 * what a remote connector is — can finally read them. Under the old revision they
 * existed only on the initialize request, handled by a different Server object, and
 * `hostRendersUi()` could never see them. See the note on that function.
 *
 * Handler registration changed shape and nothing else: a method NAME where v1 took
 * a Zod schema constant. The tool table, the schemas, the card and every tool body
 * are untouched.
 *
 * The v1 package is UNINSTALLED (2026-09-13) — the two were installed side by side
 * only while the migration was in flight, so the build stayed green between steps.
 * Nothing imports `@modelcontextprotocol/sdk` any more; `npm ls` no longer has it.
 * Result schemas for tests come from this package's own `specTypeSchemas` — the
 * very objects v2 validates against — not from `@modelcontextprotocol/core`,
 * which is a transitive dependency that only resolves by npm's hoisting.
 */
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { loadConfig, ConfigError, type Config } from './config.js';
import { VidofyError } from './backend.js';
import { listModes, listModelsInput, listModels, getModelInput, getModel } from './tools/info.js';
import {
    estimateCostInput, estimateCost,
    generateInput, generate,
    generationIdInput, getStatus, getResult, generationResultInput, takePreview, cardState,
} from './tools/generation.js';
import { getBalance, getUsageInput, getUsage } from './tools/account.js';

/* stderr, always — see the note above about stdout. Moved to its own leaf module
   so `tools/` and `oauth/` can log without importing this file, which would make a
   cycle; imported AND re-exported here so existing importers keep working and the
   six call sites in this file still resolve. */
import { log } from './log.js';
export { log };

/** The version from package.json, so the User-Agent cannot drift from the release. */
export function readVersion(): string {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        // dist/index.js → ../package.json
        const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
        return pkg.version ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * The tool table.
 *
 * Annotations are not decoration — a client uses `readOnlyHint` to decide
 * whether it may call something without asking the user first. Every tool here
 * is read-only EXCEPT `generate`, which spends the user's balance and says so
 * with readOnlyHint:false and idempotentHint:false.
 */
/* ── MCP Apps (SEP-1865) ──────────────────────────────────────────────────
 *
 * A generation is a slow thing with a picture at the end, and a tool result is
 * neither. Base64 in the result hits the host's 1 MB ceiling — 81% of real
 * images are over it — and a URL is invisible to the model. This extension is
 * the way out: the tool returns a small object, the host renders an HTML view
 * in a sandboxed iframe, and the image loads straight from R2 with an <img>.
 * No bytes in the result at all, so no ceiling.
 *
 * The CLIENT declares support, in its initialize request; the server declares
 * nothing and is told to check before registering UI-enabled tools. Measured
 * on this machine 2026-09-08: Claude Desktop declares it to a LOCAL STDIO
 * server, which is what made this worth building.
 *
 * Everything here is conditional on that declaration. A client without it gets
 * exactly the tools it got before — same names, same shapes, image block and
 * link included — because a server that only works with a UI is a server that
 * breaks for every text-only client.
 */
const CARD_URI = 'ui://vidofy/generation-card';

/**
 * Whether this host can render an MCP Apps view.
 *
 * ⚠ THIS ANSWERS `false` ON THE REMOTE CONNECTOR, ALWAYS — and not because the
 * host is text-only. Measured 2026-09-12 against a server built exactly like
 * http.ts:
 *
 *   initialize  → getClientCapabilities() = {"extensions":{"io.modelcontextprotocol/ui":…}}
 *   tools/list  → getClientCapabilities() = undefined
 *
 * `/mcp-app` is stateless: a fresh buildServer() and a fresh transport per HTTP
 * request. So `initialize` and `tools/list` are answered by two DIFFERENT Server
 * objects, and the one that lists the tools never saw a handshake. The SDK v2
 * documents the same thing on its own capability accessor: "Per-request
 * instances that never saw an initialize (stateless legacy) hold nothing, so
 * gates refuse there."
 *
 * That is the whole reason the card shows in Claude Desktop and not on
 * claude.ai — stdio is one long-lived server, a remote connector is not. It is
 * NOT claude.ai declining to declare support; `extensions` is a declared field
 * of ClientCapabilitiesSchema (sdk types.js:455) and survives parsing intact.
 *
 * The fix is protocol 2026-07-28, where client capabilities ride `_meta` on
 * EVERY request, via @modelcontextprotocol/server@2.0.0 — measured to deliver
 * them to a handler with no initialize at all. Until that migration lands this
 * gate is honest for stdio and structurally shut for the connector, which is
 * why nothing here is "fixed" by loosening it: attaching the view to a host
 * that cannot render it trades a missing card for a blank frame.
 */
function hostRendersUi(server: Server): boolean {
    const caps = server.getClientCapabilities() as
        | { extensions?: Record<string, unknown> }
        | undefined;
    return caps?.extensions?.['io.modelcontextprotocol/ui'] !== undefined;
}

/**
 * A tool's inputSchema, narrowed to the object schema the protocol requires.
 *
 * zodToJsonSchema is typed to return the WHOLE JSON-Schema union — a string schema,
 * a number schema, anything — while v2's ToolSchema requires `type: "object"`
 * literally. v1 accepted the union, which is why this is new: the stricter type is
 * the newer library being right.
 *
 * Asserted at runtime rather than cast. Every call passes a `z.object`, so the
 * narrowing is sound today, and a cast would stay silent on the day somebody
 * declares a tool input as `z.string()` — the failure would then surface at the
 * protocol boundary as a rejected tools/list with nothing naming the tool. This
 * throws at startup, naming it.
 *
 * ⚠ The inner call is `zodToJsonSchema`, not this function. It was written as a
 * self-call once (2026-09-13) and the result was total: infinite recursion, so
 * `buildServer` threw before constructing a single tool and every request — stdio
 * and HTTP alike — answered nothing. `tsc` cannot see it (the types are sound, a
 * function may call itself), the build succeeds, and the line reads correctly at a
 * glance. Only running the server catches it.
 */
function objectSchema(zod: Parameters<typeof zodToJsonSchema>[0]): { type: 'object' } & Record<string, unknown> {
    const js = zodToJsonSchema(zod) as Record<string, unknown>;
    if (js['type'] !== 'object') {
        throw new Error(
            `A tool inputSchema must be an object schema; got type=${JSON.stringify(js['type'])}. `
            + 'Wrap the input in z.object({ … }).'
        );
    }
    return js as { type: 'object' } & Record<string, unknown>;
}

/** The card's HTML, read from dist/ui — copied there by build/copy-ui.mjs. */
function cardHtml(): string {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ui', 'generation-card.html'), 'utf8');
}

function registerTools(server: Server, cfg: Config): void {
    const tools = [
        {
            name: 'list_modes',
            description:
                'List what Vidofy can generate — text-to-image, image-to-video, lipsync, ' +
                'text-to-speech and so on. Start here, then call list_models with the mode code.',
            inputSchema: { type: 'object' as const, properties: {} },
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async () => listModes(cfg),
        },
        {
            name: 'list_models',
            description:
                'List the models available in one mode, with the rough duration of each and ' +
                'credits_from — the CHEAPEST that model can cost, for comparing models against ' +
                'each other. It is not the price of a request and is often several times under ' +
                'it; only estimate_cost answers that. Use the mode code from list_modes (e.g. "t2i").',
            inputSchema: objectSchema(listModelsInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async (args: unknown) => listModels(cfg, listModelsInput.parse(args)),
        },
        {
            name: 'get_model',
            description:
                'Everything needed to call generate on one model: a JSON Schema for its inputs, ' +
                'which file slots it takes and their size limits, and notes the schema cannot ' +
                'express. Call this after list_models and before generate. Its credits_from is ' +
                'the model\'s cheapest possible price, not this request\'s — quote estimate_cost.',
            inputSchema: objectSchema(getModelInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async (args: unknown) => getModel(cfg, getModelInput.parse(args)),
        },
        {
            name: 'estimate_cost',
            description:
                'What a generation will cost, before running it. Pass the SAME input you will ' +
                'pass to generate — on some models the price varies 20x with the settings. ' +
                'Show this to the user before spending their balance.',
            inputSchema: objectSchema(estimateCostInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async (args: unknown) => estimateCost(cfg, estimateCostInput.parse(args)),
        },
        {
            name: 'generate',
            description:
                'Run a generation. THIS SPENDS THE USER\'S BALANCE — call estimate_cost first ' +
                'and tell them the price. Charged when the job is submitted, not when it ' +
                'succeeds. Returns immediately with an id; the media is not ready yet. Check ' +
                'get_status — which waits for you — and obey the check_again_in_seconds it ' +
                'returns, then call get_result. Typical waits are 30 seconds for audio and one ' +
                'to three minutes for an image or a video, so tell the user it is running ' +
                'rather than checking over and over. Output is private unless public:true — ' +
                'except on a free account, where it is always published and watermarked. ' +
                'To chain — animate an image you just made, lipsync a video, and so on — pass ' +
                '{"from_generation": "<earlier id>"} as the file input instead of a path. ' +
                'Never download a Vidofy result just to upload it back.',
            inputSchema: objectSchema(generateInput),
            /* NOT readOnlyHint — this is the one tool that costs money, and
               that flag is what a client uses to decide whether to run
               something without asking. destructiveHint stays false: it
               creates, it never removes. idempotentHint false because two
               identical calls are two generations and two charges — the
               Idempotency-Key makes ONE call's retries safe, which is a
               different claim. */
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
            },
            /* The only tool that takes the second argument. Every other `run`
               below declares one parameter and stays valid — a function that
               ignores an argument satisfies a signature that provides one. */
            run: async (args: unknown, ctx?: { signal?: AbortSignal }) =>
                generate(cfg, generateInput.parse(args), ctx),
        },
        {
            name: 'get_balance',
            description:
                'The account balance, and how much of it expires with the current subscription. ' +
                'Check before a costly generation.',
            inputSchema: { type: 'object' as const, properties: {} },
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async () => getBalance(cfg),
        },
        {
            name: 'get_usage',
            description:
                'Recent generations and what they cost: totals for the window plus the rows ' +
                'behind them. Use it to answer "what have I spent".',
            inputSchema: objectSchema(getUsageInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async (args: unknown) => getUsage(cfg, getUsageInput.parse(args)),
        },
        {
            name: 'get_status',
            description:
                'Whether a generation has finished. Returns done:true once it reaches a final ' +
                'state, then call get_result. This call WAITS for up to 10 seconds before ' +
                'answering, so it is never instant and never needs repeating straight away. ' +
                'While a job is running the answer carries check_again_in_seconds — wait at ' +
                'least that long before calling again. Nothing finishes in under 10 seconds and ' +
                'most media takes one to three minutes, so calling in a tight loop only spends ' +
                'the user\'s context to learn nothing.',
            inputSchema: objectSchema(generationIdInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async (args: unknown) => getStatus(cfg, generationIdInput.parse(args)),
        },
        {
            name: 'get_result',
            description:
                'The finished media, returned as an image you can actually see — an image ' +
                'comes back as itself, a video as its poster frame. Also gives the link: ' +
                'whether it lasts depends on the generation, a private one is signed and ' +
                'expires in about 8 hours, a public one is a permanent CDN URL. The url_note ' +
                'field says which — read it before telling the user to save the link, and ' +
                'call this again for a fresh one if it expired. Pass include_preview:false to ' +
                'get the link alone.',
            inputSchema: objectSchema(generationResultInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            run: async (args: unknown) => getResult(cfg, generationResultInput.parse(args)),
        },
        {
            /* The card's own eyes. Registered app-only — the model never sees
             * it, so a two-minute generation costs no tokens to wait through
             * and leaves no trail of polling in the transcript.
             *
             * It exists because the alternative is worse: the view could fetch
             * /app/v1 directly, but then this page — HTML the host renders in
             * an iframe — would have to hold the user's MCP token. Routing the
             * poll through the host to the server keeps the credential where
             * it already is. */
            name: 'generation_card_state',
            description: 'Internal: current state of a generation, for the card view.',
            inputSchema: objectSchema(generationIdInput),
            annotations: { readOnlyHint: true, openWorldHint: true },
            appOnly: true,
            run: async (args: unknown) => cardState(cfg, generationIdInput.parse(args)),
        },
    ];

    server.setRequestHandler('tools/list', async () => {
        const ui = hostRendersUi(server);
        return {
            tools: tools
                // A host that cannot render the view must not be shown a tool
                // built only for it — it would be dead weight in the model's
                // list, and one it might well try to call.
                .filter((t) => ui || !('appOnly' in t && t.appOnly))
                .map(({ name, description, inputSchema, annotations, ...rest }) => ({
                    name,
                    description,
                    inputSchema,
                    annotations,
                    /* The view is attached HERE, at list time, rather than
                     * baked into the definition: capabilities are known only
                     * after the handshake, and this handler runs after it.
                     *
                     * `generate` ONLY — deliberately not get_result. A card
                     * follows its own generation to the end, so putting one on
                     * get_result too meant the model calling it produced a
                     * SECOND card below the first: the result appeared
                     * somewhere new instead of in the card the user was already
                     * watching, and the finished card sat above it, stale.
                     * get_result keeps its text and its image block, which is
                     * what lets the model actually look at the output. */
                    ...(ui && (name === 'generate' || 'appOnly' in rest)
                        ? {
                              _meta: {
                                  ui: {
                                      resourceUri: CARD_URI,
                                      visibility: 'appOnly' in rest ? ['app'] : ['model', 'app'],
                                  },
                              },
                          }
                        : {}),
                })),
        };
    });

    /* The view itself.
     *
     * resourceDomains is the field that decides whether the picture appears:
     * without it the host applies its default img-src 'self' data: and the
     * card renders an empty frame however correct everything else is. Two
     * hosts are needed because an output lives in one of two places — the
     * public CDN when the user published it, and the private R2 bucket behind
     * a signed URL otherwise, whose subdomain carries the account id and so
     * differs per deployment; the wildcard covers it without pinning ours into
     * a package other people install.
     *
     * connectDomains stays EMPTY on purpose. The card talks to the host, never
     * to the network — see generation_card_state above. Granting it network
     * reach it does not use would be handing an iframe a capability for
     * nothing. */
    server.setRequestHandler('resources/read', async (req) => {
        if (req.params.uri !== CARD_URI) {
            throw new VidofyError('RESOURCE_NOT_FOUND', `No resource at ${req.params.uri}.`);
        }
        return {
            contents: [
                {
                    uri: CARD_URI,
                    mimeType: 'text/html;profile=mcp-app',
                    text: cardHtml(),
                    _meta: {
                        ui: {
                            csp: {
                                connectDomains: [],
                                resourceDomains: [
                                    'https://cdn.vidofy.ai',
                                    'https://*.r2.cloudflarestorage.com',
                                    /* The site's own origin, derived rather than
                                     * written down: model logos are served from
                                     * it (the server prefixes the stored path
                                     * with its own origin), and it differs
                                     * between a local instance and production.
                                     * Omit it and the card falls
                                     * back to a plain mark, which is a smaller
                                     * failure than a blank frame but still a
                                     * silent one. */
                                    new URL(cfg.baseUrl).origin,
                                ],
                            },
                            prefersBorder: false,
                        },
                    },
                },
            ],
        };
    });

    /* Listed, though the spec says UI-only resources MAY be omitted. Showing it
     * costs one line and makes the server legible to anyone poking at it with
     * an inspector, which is worth more than the line. */
    server.setRequestHandler('resources/list', async () => ({
        resources: hostRendersUi(server)
            ? [{ uri: CARD_URI, name: 'Vidofy generation card', mimeType: 'text/html;profile=mcp-app' }]
            : [],
    }));

    server.setRequestHandler('tools/call', async (req, ctx) => {
        const tool = tools.find((t) => t.name === req.params.name);
        if (!tool) {
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
                isError: true,
            };
        }
        try {
            /* `extra` was not even received here until 2026-09-13, so the
             * cancellation signal the SDK provides was discarded.
             *
             * It is real and it is prompt — measured: a client that disconnects
             * mid-call has this signal aborted 5 ms later, because http.ts closes
             * the server on the response's `close` event and Protocol._onclose
             * aborts every in-flight request handler.
             *
             * Passed to every tool, honoured by `generate` alone, and that is
             * deliberate rather than unfinished: for a read-only tool, stopping
             * early saves a few hundred milliseconds of work nobody is waiting
             * for. For `generate` it is the difference between charging a user's
             * coins for a request they abandoned and not charging them. See the
             * checkpoints in tools/generation.ts — and the note there about why
             * the signal must NOT be wired into the submit itself.
             *
             * ⚠ `ctx.mcpReq.signal` in v2, NOT `ctx.signal` as it was in v1 — the
             * v2 context nests everything about the request under `mcpReq`. tsc
             * caught the rename, which is the only reason it was not a silent
             * regression: `undefined?.signal` is `undefined`, `abandoned()` would
             * have read false forever, and the money guard would have become a
             * no-op that still looked present in the diff. */
            const result = await tool.run(req.params.arguments ?? {}, { signal: ctx?.mcpReq?.signal });

            /* A tool may attach media to be SEEN, not just described.
             *
             * The model cannot look at a URL — it is a string. An image content
             * block is the protocol's way to put the pixels in front of both
             * the user and the model, and get_result uses it so an agent can
             * say the light is wrong or which of two takes is better instead of
             * handing over an address it has never opened.
             *
             * Held BESIDE the result in a WeakMap, never as a key on it. It was
             * a Symbol key for a while — chosen so JSON.stringify would skip it
             * — and that is precisely what broke every get_result carrying an
             * image: the SDK validates the whole result against
             * CallToolResultSchema, structuredContent is a record keyed by
             * strings, and Zod walks own symbol keys too. The response was
             * refused before it left as -32602, and the host said only "Failed
             * to call tool". A WeakMap puts no key on the object at all. */
            const image = takePreview(result);

            /* The last word on size, and the only one that weighs what is
             * actually sent.
             *
             * getResult estimates before fetching and again after encoding, but
             * neither sees THIS object: the text is serialised with indentation
             * here, structuredContent repeats it, and the frame carries its own
             * JSON-RPC envelope. Under-count by a few kilobytes and the host
             * rejects the whole result — the caller loses the url, the id and
             * the status, not merely the picture — which is exactly the
             * "Failed to call tool" an agent reported.
             *
             * Measured rather than reasoned about: build it, serialise it, and
             * if it will not fit, send the same result without the image and
             * say so. */
            const text = JSON.stringify(result, null, 2);
            const withImage =
                image !== null &&
                Buffer.byteLength(text, 'utf8') * 2 + image.data.length + 4_096 <= 1_000_000;

            return {
                content: [
                    {
                        type: 'text' as const,
                        text:
                            image !== null && !withImage
                                ? text +
                                  '\n\n(The image was left out — the result would have exceeded the ' +
                                  '1 MB a tool result may carry. Open the url.)'
                                : text,
                    },
                    ...(withImage && image !== null
                        ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }]
                        : []),
                ],
                /* The same object again, as data rather than prose.
                 *
                 * This is how the generation card is fed: the host forwards it
                 * to the view as ui/notifications/tool-result, and the view's
                 * tools/call reads it back as res.structuredContent. It is
                 * specified as NOT entering the model's context, so the model
                 * still reads the text block above and nothing it sees
                 * changes — the duplication is the point, not an oversight. */
                ...(result !== null && typeof result === 'object' && !Array.isArray(result)
                    ? { structuredContent: result as Record<string, unknown> }
                    : {}),
            };
        } catch (err) {
            /* isError, not a thrown exception. A thrown error becomes a
               protocol-level failure the model cannot read or recover from;
               an isError result puts the reason in front of it, so it can fix
               the argument and try again. */
            const text =
                err instanceof VidofyError
                    ? `${err.code}: ${err.message}` +
                      (Object.keys(err.details).length ? `\n${JSON.stringify(err.details)}` : '')
                    : err instanceof Error
                      ? err.message
                      : String(err);
            log(`tool ${req.params.name} failed — ${text}`);
            return {
                content: [{ type: 'text' as const, text }],
                isError: true,
                /* An error needs a BODY, because the card is bound to `generate`
                 * at list time (see _meta.ui above) — so a generate that fails
                 * still renders one. With content alone the view had nothing to
                 * read: structuredContent came through undefined, so it found no
                 * id, printed "checking…", called poll(), and poll() returned on
                 * its first line because there was no id to poll. No timer was
                 * ever set. The card stayed at "checking…" for the life of the
                 * conversation, over a generation that had already failed.
                 *
                 * These are the field names generation_card_state already
                 * returns, so the view's existing failure path reads them with
                 * no special case. `refunded` is deliberately absent rather than
                 * false: whether the coins came back is not known here, and the
                 * view prints that line only when it is told so.
                 *
                 * Harmless on the tools that have no card — nothing reads it.
                 * It does not reach the model either: structuredContent is
                 * specified as not entering the model's context, and the same
                 * text is already in the content block above. */
                structuredContent: { status: 'error', done: true, error: text },
            };
        }
    });
}

/**
 * Build a fully wired Server for one credential — everything except the
 * transport.
 *
 * Extracted from main() so the remote transport can reuse it (src/http.ts).
 * The split matters for one reason that is easy to miss: over stdio this
 * process serves exactly ONE account for its whole life, while over HTTP each
 * request carries a different person's token. So the Server cannot be a
 * module-level singleton — it is built per caller, around that caller's Config,
 * and `cfg` being a parameter rather than a global is what makes spending the
 * wrong account's coins impossible by construction.
 */
export function buildServer(cfg: Config, version: string): Server {
    const server = new Server(
        { name: 'vidofy', version },
        // `resources` is declared because the generation card is served as one
        // (ui://vidofy/generation-card). A client that supports MCP Apps reads
        // it through resources/read, and a server that never advertised the
        // capability is one it will not ask.
        { capabilities: { tools: {}, resources: {} } }
    );

    /* Anything the transport itself rejects — a malformed JSON-RPC frame, for
       one — is discarded silently by Protocol._onerror unless a handler is
       assigned. Silence during a handshake failure is the hardest kind of bug
       to report, so it goes to the client's log. */
    server.onerror = (err: unknown): void => {
        log(`protocol error: ${err instanceof Error ? err.message : String(err)}`);
    };

    if (cfg.mode === 'key') {
        /* This server is a PERSONAL product and stays one (owner decision,
         * 2026-09-11): it spends the user's own coins, and an API key bills a
         * balance it does not serve. Key mode is detected only so the refusal
         * can explain itself rather than surfacing later as a bare 401.
         *
         * So no tools are registered here — and the message says the door is
         * closed rather than "not yet". It read "not implemented yet"
         * until the decision, which promised something that is not coming and
         * left a partner waiting for it instead of using the API they already
         * have.
         *
         * Nothing is registered rather than registering six tools that fail:
         * they speak /app/v1 shapes, and /api/v1/info/model-info returns only
         * the options — no name, model_key, credits or media_type (measured
         * 2026-09-11) — so get_model alone could not fill half its answer.
         * Six broken tools are worse than none. */
        log('VIDOFY_API_KEY is not supported: this server is for personal Vidofy accounts '
            + 'and bills your own coins. Set VIDOFY_TOKEN (vmt_…) instead — create one at '
            + 'https://vidofy.ai/en/studio/account/mcp-tokens.');
        // Still answer tools/list. We advertised the `tools` capability, so a
        // client WILL ask; an empty list is a valid answer, whereas leaving the
        // method unhandled returns -32601 and reads as a broken server.
        server.setRequestHandler('tools/list', async () => ({ tools: [] }));
    } else {
        registerTools(server, cfg);
    }

    /* Record what the host says it can do, once, after the handshake.
     *
     * This is the cheapest possible answer to a question that otherwise costs a
     * feature to answer: can this client render an MCP Apps UI (SEP-1865), so a
     * generation could show its own progress and its image inline instead of
     * riding as base64 inside a tool result, where the host's 1 MB ceiling
     * rejects 81% of real outputs?
     *
     * The extension is declared by the CLIENT, in its initialize request, under
     * capabilities.extensions["io.modelcontextprotocol/ui"] — the server
     * declares nothing, and the spec says servers SHOULD check this before
     * registering UI-enabled tools. So the presence of that key IS the answer,
     * and no HTML has to be written to find it out. It also matters per
     * transport: the extension's docs state no restriction either way, and this
     * server is local stdio while every sighting so far has been a remote one.
     *
     * Left in permanently rather than removed after the experiment: when the UI
     * lands it has to be registered conditionally anyway, and a line in the
     * client's own log is how anyone diagnoses "why is there no widget". */
    server.oninitialized = (): void => {
        try {
            const caps = server.getClientCapabilities() ?? {};
            const ui = (caps as { extensions?: Record<string, unknown> }).extensions?.[
                'io.modelcontextprotocol/ui'
            ];
            log(
                `client capabilities: ${JSON.stringify(caps)} — MCP Apps (ui): ` +
                (ui === undefined ? 'NOT declared' : `declared ${JSON.stringify(ui)}`)
            );
        } catch (err) {
            log(`could not read client capabilities: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    return server;
}

/** The stdio entry point: ONE account, read from the environment, for the life of the process. */
async function main(): Promise<void> {
    const version = readVersion();

    let cfg;
    try {
        cfg = loadConfig(process.env, version);
    } catch (err) {
        /* A misconfiguration is the single most likely reason someone lands
           here, so it gets a readable line and a non-zero exit instead of a
           stack trace the client would swallow. */
        if (err instanceof ConfigError) {
            log(`configuration error: ${err.message}`);
            process.exit(1);
        }
        throw err;
    }

    const server = buildServer(cfg, version);
    const transport = new StdioServerTransport();
    await server.connect(transport);

    log(`ready — mode=${cfg.mode} base=${cfg.baseUrl} v${version}`);
}

/* Run main() only when this file IS the program, not when it is imported.
 *
 * src/http.ts imports buildServer from here. Without this guard that import
 * would START A STDIO SERVER as a side effect — which over HTTP means a second
 * server reading VIDOFY_TOKEN from the environment and holding stdin open, and
 * the symptom would be the remote process appearing to hang at boot with no
 * error anywhere. The comparison is the standard ESM main-module test: argv[1]
 * is the script node was given, import.meta.url is this module. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err: unknown) => {
        log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
}
