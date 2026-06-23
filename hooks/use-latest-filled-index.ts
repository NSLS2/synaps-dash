'use client';

import { useEffect, useState } from 'react';
import { fetchArrayBytesIfChanged, fetchArrayInfo, getMetadata } from '@/lib/tiled/client';

/**
 * Track the index of the most-recent slot for which a position, a diffraction
 * frame, AND a ViT inference patch have all landed in Tiled.
 *
 * Three writers populate the per-run container at different rates:
 *   - PositionsWriterOp rewrites the whole `(nz, 2)` `positions_um` array
 *     per batch (cheap, small payload). Once PandA has finished, the array
 *     is fully populated.
 *   - FrameWriterOp pushes ~1 MB per 64-frame patch over WAN to update
 *     `<run>/diffraction/dp[i:i+64]`. Drains long after the publisher
 *     finishes, and lags positions by tens of thousands of frames during a
 *     fast scan. It stamps a monotonic `dp_frames_written` into the run
 *     metadata after each batch (throttled to ~1s).
 *   - The ViT inference op appends per-frame patches to
 *     `<run>/diffraction/inference` (shape `(n, 2, H, W)`), and lags both of
 *     the above. Its written frame count is the array's leading dimension.
 *     Requesting a patch that hasn't been written yet makes Tiled answer with
 *     a 500, so the index must be clamped to this too. Absent on older runs.
 *
 * The slider's max needs to be the minimum of all three — otherwise users
 * scroll past actually-written data into the buffer's zero-init, or request an
 * inference patch that doesn't exist yet.
 *
 * Returns `null` until at least one source is populated. The value only
 * ever increases — polling races that briefly return a stale snapshot
 * don't make the tile jump backwards.
 */
export function useLatestFilledIndex(
  runPath: string,
  pollIntervalMs: number = 2000,
): number | null {
  const [latest, setLatest] = useState<number | null>(null);

  useEffect(() => {
    // Caller passes an empty runPath when the run has no diffraction subtree
    // yet (e.g. a fresh run whose container metadata listing hasn't landed).
    // Skip the fetch entirely — building `${''}/positions_um` would hit the
    // catalog root and 404.
    if (!runPath) return;

    let cancelled = false;
    let etag: string | null = null;
    let inflight = false;
    let hi = -1;
    // Persistent high-water for positions: once a row is seen non-NaN it stays
    // filled, so we never need to walk back below it. Kept across ticks so a
    // later 304 (unchanged) doesn't lose the value.
    let posWatermark = -1;

    const positionsPath = `${runPath}/positions_um`;
    const inferencePath = `${runPath}/diffraction/inference`;

    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        // Positions side: walk backwards through positions_um for the last
        // non-NaN row, advancing the persistent high-water mark.
        const info = await fetchArrayInfo(positionsPath).catch(() => null);
        if (info && info.dtype.kind === 'f') {
          const result = await fetchArrayBytesIfChanged(positionsPath, ':,:', etag);
          if (!cancelled && result.status === 'changed') {
            etag = result.etag;
            const data =
              info.dtype.itemsize === 8
                ? new Float64Array(result.buffer)
                : new Float32Array(result.buffer);
            const cols = info.shape[1] ?? 2;
            const nz = info.shape[0] ?? data.length / cols;
            for (let row = nz - 1; row >= 0; row--) {
              if (!Number.isNaN(data[row * cols])) {
                if (row > posWatermark) posWatermark = row;
                break;
              }
            }
          }
          // 'unchanged' / 'error' → keep the existing posWatermark.
        }
        // Nothing usable from positions yet — can't bound anything.
        if (posWatermark < 0) return;
        const positionsHi = posWatermark;

        // Dp side: read dp_frames_written from run metadata. Older runs
        // without the field treat it as Infinity (no dp clamp).
        let dpHi = Number.POSITIVE_INFINITY;
        const meta = await getMetadata(runPath).catch(() => null);
        const written = meta && (meta.dp_frames_written as number | undefined);
        if (typeof written === 'number' && written > 0) {
          dpHi = written - 1;
        }

        // Inference side: the ViT inference op appends per-frame patches to
        // diffraction/inference; its leading dim is the written frame count.
        // Older runs without inference 404 here → Infinity (no clamp).
        let inferenceHi = Number.POSITIVE_INFINITY;
        const infInfo = await fetchArrayInfo(inferencePath).catch(() => null);
        if (infInfo && infInfo.shape.length >= 1 && infInfo.shape[0] > 0) {
          inferenceHi = infInfo.shape[0] - 1;
        }

        const combined = Math.min(positionsHi, dpHi, inferenceHi);
        if (combined > hi && combined >= 0) {
          hi = combined;
          if (!cancelled) setLatest(combined);
        }
      } finally {
        inflight = false;
      }
    };

    tick();
    if (!pollIntervalMs) return () => { cancelled = true; };
    const handle = setInterval(tick, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [runPath, pollIntervalMs]);

  return latest;
}
