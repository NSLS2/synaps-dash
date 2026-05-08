'use client';

import { useEffect, useState } from 'react';
import { fetchArrayBytesIfChanged, fetchArrayInfo } from '@/lib/tiled/client';

/**
 * Track the index of the most recent filled row in `<run>/positions_um`.
 *
 * holoptycho writes a `(nz, 2) float64` positions buffer with NaN in rows
 * the PandA stream hasn't reached yet. The number of non-NaN rows is the
 * count of frames that have arrived; the `latestFilledIndex` we return is
 * `nz_filled - 1` — i.e. a slice index suitable for fetching the most
 * recent diffraction frame from the matching `<run>/diffraction/dp` array.
 *
 * Returns `null` until the first poll succeeds. Returns a non-negative
 * number while frames are arriving. The value only ever increases —
 * polling races that briefly return a stale snapshot don't make the tile
 * jump backwards.
 */
export function useLatestFilledIndex(
  runPath: string,
  pollIntervalMs: number = 2000,
): number | null {
  const [latest, setLatest] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let etag: string | null = null;
    let inflight = false;
    let hi = -1;

    const positionsPath = `${runPath}/positions_um`;

    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const info = await fetchArrayInfo(positionsPath).catch(() => null);
        if (!info || info.dtype.kind !== 'f') return;
        const result = await fetchArrayBytesIfChanged(positionsPath, ':,:', etag);
        if (cancelled || result.status === 'unchanged' || result.status === 'error') return;
        etag = result.etag;
        const data =
          info.dtype.itemsize === 8
            ? new Float64Array(result.buffer)
            : new Float32Array(result.buffer);
        // positions_um is (nz, 2). Walk backwards along axis 0 and stop at
        // the first non-NaN row — that's the highest-index filled frame.
        const cols = info.shape[1] ?? 2;
        const nz = info.shape[0] ?? data.length / cols;
        let found = -1;
        for (let row = nz - 1; row >= 0; row--) {
          if (!Number.isNaN(data[row * cols])) {
            found = row;
            break;
          }
        }
        if (found > hi) {
          hi = found;
          if (!cancelled) setLatest(found);
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
