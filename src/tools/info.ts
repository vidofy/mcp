/**
 * The read-only catalogue tools: what can Vidofy do, with which model, and
 * what does that model need.
 *
 * These are what an agent calls first, and they are the proof that the
 * transport works end to end — no credential spending, no state change.
 *
 * list_modes → list_models → get_model is the intended path: the first two are
 * cheap and slim, the third is the detailed one you ask for once you have
 * chosen.
 *
 * THE FIRST TWO SLIM THE RESPONSE HARD, on purpose. /app/v1/info/models-flat/t2i is
 * 116 KB because every item carries the model's full m_options (upload rules,
 * dynamic fields, posters, preview video). Handing that to a language model
 * would burn its context to list fifty names. Slimmed to what a chooser needs,
 * the same call is 6.9 KB — measured 2026-09-06. The full options come back on
 * demand through get_model, which is what they are for.
 */

import { z } from 'zod';

import type { Config } from '../config.js';
import { request } from '../backend.js';
import { buildModelSchema } from '../schema.js';

/* ── list_modes ──────────────────────────────────────────────────────────── */

interface ModesResponse {
    count?: number;
    modes?: Array<Record<string, unknown>>;
}

export const listModesInput = z.object({}).describe('No arguments.');

export async function listModes(cfg: Config): Promise<unknown> {
    const res = await request<ModesResponse>(cfg, { method: 'GET', path: 'info/modes' });

    const modes = (res.modes ?? []).map((m) => ({
        // m_code is what every other endpoint wants in its URL, so it leads.
        mode: m['m_code'],
        name: m['m_name'],
        description: m['m_description'] ?? null,
        media_type: m['m_media_type'],
        input_type: m['m_input_type'],
        models: m['models_count'],
        default_model: m['m_default_model'] ?? null,
    }));

    return { count: modes.length, modes };
}

/* ── list_models ─────────────────────────────────────────────────────────── */

interface ModelsFlatResponse {
    mode?: string;
    mode_code?: string;
    default_model?: string | null;
    count_flat?: number;
    /* NOT `models`. The endpoint's list key is `models_flat` — checked against
       a live response, because guessing it would have produced an empty list
       with a successful status and no clue why. */
    models_flat?: Array<Record<string, unknown>>;
}

export const listModelsInput = z.object({
    mode: z
        .string()
        .min(1)
        .describe(
            'Mode code from list_modes — e.g. t2i, t2v, i2v, lipsync. Not the long name.'
        ),
});

export async function listModels(cfg: Config, args: { mode: string }): Promise<unknown> {
    const res = await request<ModelsFlatResponse>(cfg, {
        method: 'GET',
        path: `info/models-flat/${encodeURIComponent(args.mode)}`,
    });

    const models = (res.models_flat ?? []).map((m) => ({
        // model_key is the identifier generate() takes; slug is what get_model
        // and the website URLs use. Both are needed, and they are not the same
        // string — 'Qwen_image_3_0_pro_t2i' vs 'qwen-image-3-0-pro-t2i'.
        model_key: m['m_model_key'],
        slug: m['m_slug'],
        name: m['m_name'],
        /* The FLOOR across every option combination, not the price of any
           particular request — see ModelSchema.credits_from in schema.ts for
           why the name carries the qualifier. Comparable between models on
           this list, which is what a picker needs; never quotable to a user. */
        credits_from: m['m_coins'],
        estimated_seconds: m['m_sec'],
        media_type: m['m_media_type'],
        quality: m['m_quality'] ?? null,
        summary: m['m_title'] ?? null,
    }));

    return {
        mode: res.mode_code ?? args.mode,
        default_model: res.default_model ?? null,
        count: models.length,
        models,
    };
}

/* ── get_model ───────────────────────────────────────────────────────────── */

export const getModelInput = z.object({
    model: z
        .string()
        .min(1)
        .describe(
            'The model slug from list_models (e.g. "nano-banana-2-t2i"). ' +
            'The slug, not the model_key — they differ in case and separators.'
        ),
});

/**
 * Everything needed to call generate on one model: a JSON Schema for its
 * inputs, the wire names, the file slots with their limits, and the notes a
 * schema cannot express.
 *
 * This is where a model's full options are meant to be read — list_models
 * strips them precisely because they belong here and nowhere else.
 */
export async function getModel(cfg: Config, args: { model: string }): Promise<unknown> {
    const payload = await request(cfg, {
        method: 'GET',
        path: `info/model-info/${encodeURIComponent(args.model)}`,
    });
    return buildModelSchema(payload);
}
