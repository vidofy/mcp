/**
 * How long is this media file, read from its own header.
 *
 * WHY THIS EXISTS. Nine active models cap the LENGTH of what you upload —
 * lipsync and motion-control mostly, 30s of video or 30-600s of audio. The
 * server enforces it and says so clearly ("Video file too long (45s). Max
 * allowed per video file: 30s."), before anything is charged. What it cannot
 * do is refund the upload: a 200 MB clip travels in full to be told it is
 * fifteen seconds too long. The studio avoids that in the browser, by asking
 * a <video> element for its duration. Node has no such thing, so this reads
 * the container.
 *
 * WHY IT RETURNS null RATHER THAN A GUESS. The caller REFUSES a file on this
 * number, and a wrong number refuses a legitimate upload — which is worse
 * than the wasted bandwidth it was meant to save. So every format whose
 * duration is not exactly recoverable from the header answers null, and the
 * caller then does what it did before: send it, and let the server decide.
 *
 * WHAT THAT COVERS, measured against the live catalogue rather than guessed:
 * the capped slots accept exactly four extensions — mp4, mov, mp3, wav.
 *
 *   mp4 / mov   ISO-BMFF, both of them. mvhd carries duration and timescale.
 *               EXACT. This is also where the saving is: video files are the
 *               large ones.
 *   wav         RIFF. data chunk size ÷ byte rate. EXACT.
 *   mp3         null. There is no duration in an MP3 header — it would have
 *               to be inferred from a Xing/VBRI tag or by counting frames,
 *               and an inferred number must not drive a refusal. A 30s MP3 is
 *               under a megabyte anyway, so the upload it would have saved is
 *               not worth the risk of rejecting a valid one.
 */

/** Seconds, or null when this file's format does not state it exactly. */
export function durationSecFromBuffer(buf: Buffer, extension: string): number | null {
    const ext = extension.trim().toLowerCase().replace(/^\./, '');
    if (ext === 'mp4' || ext === 'mov' || ext === 'm4a' || ext === 'm4v') {
        return isoBmffDuration(buf);
    }
    if (ext === 'wav') {
        return wavDuration(buf);
    }
    return null;
}

/* ── ISO base media file format (mp4, mov) ───────────────────────────────── */

/**
 * Walk the top-level boxes to `moov`, then its children to `mvhd`.
 *
 * Walked rather than searched: `moov` may sit at the START of the file
 * (faststart) or at the END, and scanning the bytes for the literal "mvhd"
 * would also match it inside any payload that happens to contain those four
 * characters — media data included.
 */
function isoBmffDuration(buf: Buffer): number | null {
    const moov = findBox(buf, 0, buf.length, 'moov');
    if (!moov) return null;
    const mvhd = findBox(buf, moov.contentStart, moov.end, 'mvhd');
    if (!mvhd) return null;

    const p = mvhd.contentStart;                 // payload: version, flags, …
    if (p + 4 > buf.length) return null;
    const version = buf[p];

    // v0 packs the four fields as 32-bit; v1 widens creation/modification to
    // 64 and duration to 64, leaving timescale 32.
    const tsOff  = version === 1 ? p + 20 : p + 12;
    const durOff = version === 1 ? p + 24 : p + 16;
    const durLen = version === 1 ? 8 : 4;
    if (durOff + durLen > buf.length) return null;

    const timescale = buf.readUInt32BE(tsOff);
    if (timescale === 0) return null;            // would divide by zero
    const duration = version === 1
        ? Number(buf.readBigUInt64BE(durOff))
        : buf.readUInt32BE(durOff);

    // 0xFFFFFFFF is the documented "unknown duration" marker.
    if (!Number.isFinite(duration) || duration <= 0 || duration === 0xffffffff) return null;
    return duration / timescale;
}

interface Box { contentStart: number; end: number; }

/** The first child box of `type` between [from, limit). */
function findBox(buf: Buffer, from: number, limit: number, type: string): Box | null {
    let off = from;
    while (off + 8 <= limit) {
        let size = buf.readUInt32BE(off);
        const boxType = buf.toString('latin1', off + 4, off + 8);
        let header = 8;
        if (size === 1) {
            // 64-bit size, in the eight bytes after the type.
            if (off + 16 > limit) return null;
            size = Number(buf.readBigUInt64BE(off + 8));
            header = 16;
        } else if (size === 0) {
            size = limit - off;                  // "to the end of the file"
        }
        // A size smaller than its own header, or past the limit, means the
        // file is malformed or truncated — stop rather than walk off.
        if (size < header || off + size > limit) return null;
        if (boxType === type) return { contentStart: off + header, end: off + size };
        off += size;
    }
    return null;
}

/* ── RIFF / WAVE ─────────────────────────────────────────────────────────── */

function wavDuration(buf: Buffer): number | null {
    if (buf.length < 12) return null;
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
        return null;
    }
    let byteRate = 0;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('latin1', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        const body = off + 8;
        if (size < 0 || body + size > buf.length + 1) return null;   // truncated
        if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
            byteRate = buf.readUInt32LE(body + 8);
        } else if (id === 'data') {
            dataSize = size;
        }
        // Chunks are word-aligned: an odd size is followed by a pad byte.
        off = body + size + (size % 2);
    }
    if (byteRate <= 0 || dataSize <= 0) return null;
    return dataSize / byteRate;
}
