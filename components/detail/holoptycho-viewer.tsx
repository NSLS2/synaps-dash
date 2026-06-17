'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Hash, Activity } from 'lucide-react';
import {
  fetchArrayInfo,
  fetchArrayBytesIfChanged,
  listChildren,
  getMetadata,
  type ArrayInfo,
} from '@/lib/tiled/client';
import { paintFloatArrayToCanvas } from '@/lib/tiled/colormap';
import { useTiledSubscription } from '@/hooks/use-tiled-subscription';
import { useLatestFilledIndex } from '@/hooks/use-latest-filled-index';

interface HoloptychoViewerProps {
  // Path to the run container, e.g. hxn/processed/holoptycho/{run_uid}
  path: string;
  metadata?: Record<string, unknown>;
}

interface SourceInfo {
  // Which sub-container the iterative recon lives in: 'live' or 'final', or null if absent.
  iterativeSource: 'live' | 'final' | null;
  // Whether vit/pred_latest is available.
  hasVit: boolean;
  // Whether vit/mosaic_amp is available (written by current holoptycho; absent on older runs).
  hasVitAmp: boolean;
  // Whether <run>/diffraction/dp exists (always-on for runs created by
  // current holoptycho, absent on older runs).
  hasDiffraction: boolean;
  // Whether <run>/diffraction/inference exists — the per-frame ViT patch output.
  // Absent on iterative-only runs (and older runs), so the ViT patch tiles
  // must not render for those.
  hasInference: boolean;
}

// Tiles poll on this cadence using If-None-Match. Most polls return 304 (cheap,
// just headers) — only when the upstream array's bytes change does the full
// float buffer transfer.
const POLL_INTERVAL_MS = 2000;

// Decode raw bytes from Tiled into the right TypedArray for `dtype`. We assume
// little-endian on the wire (Tiled's default, and matches every machine we
// run on); returns null if the dtype isn't one we can render.
//
// uint8 / uint16 support is here so the detector-frame amplitude tile
// (written by holoptycho when fine_tune=true) can be rendered alongside the
// float-typed reconstruction tiles.
function decodeFloatBuffer(
  buffer: ArrayBuffer,
  dtype: { kind: string; itemsize: number },
): Float32Array | Float64Array | Uint16Array | Uint8Array | null {
  if (dtype.kind === 'f' && dtype.itemsize === 4) return new Float32Array(buffer);
  if (dtype.kind === 'f' && dtype.itemsize === 8) return new Float64Array(buffer);
  if (dtype.kind === 'u' && dtype.itemsize === 2) return new Uint16Array(buffer);
  if (dtype.kind === 'u' && dtype.itemsize === 1) return new Uint8Array(buffer);
  return null;
}

// Pull the 2D display shape (height, width) out of a full array shape.
// Every tile here renders something whose final two dims are the image plane,
// so trailing (-2, -1) is the right answer for slice=0 (drops leading dim) and
// slice=":,:" (passthrough) alike.
function deriveDisplayShape(fullShape: number[]): [number, number] | null {
  if (fullShape.length < 2) return null;
  const h = fullShape[fullShape.length - 2];
  const w = fullShape[fullShape.length - 1];
  return [h, w];
}

async function discoverSources(runPath: string): Promise<SourceInfo> {
  try {
    const children = await listChildren(runPath, { limit: 10 });
    const ids = new Set(children.items.map(c => c.id));
    const iterativeSource = ids.has('live') ? 'live' : ids.has('final') ? 'final' : null;
    const hasVit = ids.has('vit');
    let hasVitAmp = false;
    if (hasVit) {
      try {
        const vitChildren = await listChildren(`${runPath}/vit`, { limit: 20 });
        hasVitAmp = vitChildren.items.some(c => c.id === 'mosaic_amp');
      } catch { /* absent on older runs */ }
    }
    const hasDiffraction = ids.has('diffraction');
    let hasInference = false;
    if (hasDiffraction) {
      try {
        const diffChildren = await listChildren(`${runPath}/diffraction`, { limit: 20 });
        hasInference = diffChildren.items.some(c => c.id === 'inference');
      } catch { /* absent on iterative-only / older runs */ }
    }
    return { iterativeSource, hasVit, hasVitAmp, hasDiffraction, hasInference };
  } catch {
    return { iterativeSource: null, hasVit: false, hasVitAmp: false, hasDiffraction: false, hasInference: false };
  }
}

interface TiledImageTileProps {
  title: string;
  subtitle?: string;
  path: string;
  // Slice expression passed to tiled — e.g. 0 for (mode, H, W) or "0,1" for (B, C, H, W)
  slice: number | string;
  // Polling cadence — set to 0/undefined to disable polling (e.g. for `final/` arrays
  // that never change after a run completes).
  pollIntervalMs?: number;
  // Called whenever a fresh image is loaded (i.e. ETag changed). Lets the parent
  // update timestamps and metadata-derived state.
  onChanged?: () => void;
}

function TiledImageTile({
  title,
  subtitle,
  path,
  slice,
  pollIntervalMs,
  onChanged,
}: TiledImageTileProps) {
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    let cancelled = false;
    let etag: string | null = null;
    let inflight = false;
    let info: ArrayInfo | null = null;
    let displayShape: [number, number] | null = null;

    const ensureInfo = async (): Promise<boolean> => {
      if (info) return true;
      try {
        info = await fetchArrayInfo(path);
      } catch {
        if (!cancelled) {
          setError('Failed to load');
          setHasLoadedOnce(true);
        }
        return false;
      }
      displayShape = deriveDisplayShape(info.shape);
      if (!displayShape) {
        if (!cancelled) {
          setError(`Unsupported array shape: [${info.shape.join(', ')}]`);
          setHasLoadedOnce(true);
        }
        return false;
      }
      // Floats (live/final reconstructions) and uint8 / uint16 (detector
      // amplitude) are the dtypes we know how to colormap.
      const dtypeOk =
        info.dtype.kind === 'f' ||
        (info.dtype.kind === 'u' && (info.dtype.itemsize === 1 || info.dtype.itemsize === 2));
      if (!dtypeOk) {
        if (!cancelled) {
          setError(`Unsupported dtype: ${info.dtype.kind}${info.dtype.itemsize}`);
          setHasLoadedOnce(true);
        }
        return false;
      }
      return true;
    };

    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        if (!(await ensureInfo())) return;
        const result = await fetchArrayBytesIfChanged(path, slice, etag);
        if (cancelled || result.status === 'unchanged') return;
        if (result.status === 'error') {
          // Only surface errors before we've ever loaded; transient polling errors
          // shouldn't replace a perfectly good last frame.
          if (!etag && !cancelled) {
            setError('Failed to load');
            setHasLoadedOnce(true);
          }
          return;
        }
        etag = result.etag;
        const data = decodeFloatBuffer(result.buffer, info!.dtype);
        if (!data) {
          if (!cancelled) {
            setError(`Unsupported dtype: ${info!.dtype.kind}${info!.dtype.itemsize}`);
            setHasLoadedOnce(true);
          }
          return;
        }
        const [h, w] = displayShape!;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Sanity-check: byte length should match h*w*itemsize. If not, the
        // slice produced a different shape than we derived — bail loudly
        // rather than rendering garbage.
        if (data.length !== h * w) {
          if (!cancelled) {
            setError(`Slice shape mismatch (${data.length} vs ${h}×${w})`);
            setHasLoadedOnce(true);
          }
          return;
        }
        paintFloatArrayToCanvas(canvas, data, w, h);
        if (cancelled) return;
        setHasLoadedOnce(true);
        setError(null);
        onChangedRef.current?.();
      } finally {
        inflight = false;
      }
    };

    tick();
    if (!pollIntervalMs) {
      return () => { cancelled = true; };
    }
    const handle = setInterval(tick, pollIntervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [path, slice, pollIntervalMs]);

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-medium">{title}</span>
        {subtitle && <span className="text-[10px] text-text-tertiary font-mono">{subtitle}</span>}
      </div>
      <div className="relative aspect-square rounded-lg overflow-hidden bg-surface-raised border border-border-subtle">
        <canvas
          ref={canvasRef}
          aria-label={title}
          className="w-full h-full object-contain"
        />
        {!hasLoadedOnce && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-beam animate-spin" />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-xs">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export function HoloptychoViewer({ path, metadata }: HoloptychoViewerProps) {
  const [sources, setSources] = useState<SourceInfo>({ iterativeSource: null, hasVit: false, hasVitAmp: false, hasDiffraction: false, hasInference: false });
  const [isDiscovering, setIsDiscovering] = useState(true);
  const [iteration, setIteration] = useState<number | null>(null);
  const [vitBatch, setVitBatch] = useState<number | null>(null);
  // Wall-clock time of the most recent refresh — drives the "updated Xs ago" indicator.
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  // Forces the relative-time string to recompute every second so the indicator ticks up.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setNowTick(t => t + 1), 1000);
    return () => clearInterval(handle);
  }, []);

  const containerMeta = metadata as {
    scan_id?: number | string;
    recon_mode?: string;
    run_uid?: string;
    dp_stride?: number;
  } | undefined;
  // Stride between persisted detector frames. 1 = every frame stored;
  // larger values mean only 1-in-N frames were saved (vit-only runs
  // default to 1000 to keep WAN writes cheap). The detector tile's
  // subtitle maps slider row → scan-frame number via this stride.
  const dpStride = Math.max(1, Number(containerMeta?.dp_stride) || 1);

  // Track the most recent filled index in <run>/positions_um — used as the
  // slice index for the detector-frame tile. Only polls when this run has
  // a diffraction subtree (every run created by current holoptycho does;
  // older runs may not).
  const latestFrameIdx = useLatestFilledIndex(
    sources.hasDiffraction ? path : '',
    sources.hasDiffraction ? POLL_INTERVAL_MS : 0,
  );
  const handleFrameChanged = useCallback(() => {
    setLastUpdateAt(Date.now());
  }, []);

  // Frame slider state. `null` = follow latest (default). Once the user
  // drags, we lock to that index until they hit "Follow" to resume tracking.
  const [selectedFrameIdx, setSelectedFrameIdx] = useState<number | null>(null);
  const displayFrameIdx =
    selectedFrameIdx !== null ? selectedFrameIdx : latestFrameIdx;
  const isFollowingLatest = selectedFrameIdx === null;

  // Initial discovery: figure out which sub-containers exist on this run.
  useEffect(() => {
    let cancelled = false;
    setIsDiscovering(true);
    setIteration(null);
    setVitBatch(null);
    discoverSources(path).then(result => {
      if (cancelled) return;
      setSources(result);
      setIsDiscovering(false);
    });
    return () => { cancelled = true; };
  }, [path]);

  // WebSocket subscription on the run container picks up newly-created sub-containers
  // (e.g. live/ appears partway through a run). We re-run discovery on creation.
  const handleNewItem = useCallback(() => {
    discoverSources(path).then(setSources);
  }, [path]);
  useTiledSubscription(path, handleNewItem, { enabled: true });

  // Each tile's onChanged fires when it loads a fresh image (ETag changed). We use it
  // to refresh the iteration/batch_num counters and stamp the "updated Xs ago" footer.
  const handleObjectChanged = useCallback(() => {
    setLastUpdateAt(Date.now());
    if (!sources.iterativeSource) return;
    getMetadata(`${path}/${sources.iterativeSource}/object`)
      .then(m => {
        const it = (m as { iteration?: number }).iteration;
        if (typeof it === 'number') setIteration(it);
      })
      .catch(() => { /* ignore */ });
  }, [path, sources.iterativeSource]);

  const handleProbeChanged = useCallback(() => {
    setLastUpdateAt(Date.now());
  }, []);

  const handleVitChanged = useCallback(() => {
    setLastUpdateAt(Date.now());
    getMetadata(`${path}/vit/mosaic`)
      .then(m => {
        const b = (m as { batch_num?: number }).batch_num;
        if (typeof b === 'number') setVitBatch(b);
      })
      .catch(() => { /* ignore */ });
  }, [path]);

  if (isDiscovering) {
    return (
      <div className="flex items-center justify-center h-64 rounded-xl bg-surface-raised border border-border-subtle">
        <Loader2 className="w-5 h-5 text-beam animate-spin" />
      </div>
    );
  }

  if (!sources.iterativeSource && !sources.hasVit && !sources.hasDiffraction) {
    return (
      <div className="flex items-center justify-center h-32 rounded-xl bg-surface-raised border border-border-subtle">
        <span className="text-sm text-text-tertiary">Run has no diffraction/, live/, final/, or vit/ data yet</span>
      </div>
    );
  }

  const objectPath = sources.iterativeSource ? `${path}/${sources.iterativeSource}/object` : '';
  const probePath = sources.iterativeSource ? `${path}/${sources.iterativeSource}/probe` : '';

  // `final/` arrays don't change after the run completes — no polling needed.
  const iterativePollMs = sources.iterativeSource === 'live' ? POLL_INTERVAL_MS : 0;
  // ViT is live whenever the iterative side is live, or whenever the run is
  // ViT-only (no iterative source at all).
  const vitPollMs = (sources.iterativeSource === 'live' || !sources.iterativeSource)
    ? POLL_INTERVAL_MS
    : 0;

  // Format last-update time as a short relative string for the footer.
  const formatRelative = (ts: number | null): string => {
    if (ts === null) return '—';
    const dt = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (dt < 1) return 'just now';
    if (dt < 60) return `${dt}s ago`;
    const m = Math.floor(dt / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {objectPath && (
          <>
            <TiledImageTile
              title={`${sources.iterativeSource === 'live' ? 'Iterative' : 'Final'} object |·|`}
              subtitle={iteration !== null ? `iter ${iteration}` : undefined}
              path={objectPath}
              slice={0}
              pollIntervalMs={iterativePollMs}
              onChanged={handleObjectChanged}
            />
            <TiledImageTile
              title={`${sources.iterativeSource === 'live' ? 'Iterative' : 'Final'} object phase`}
              subtitle={iteration !== null ? `iter ${iteration}` : undefined}
              path={objectPath}
              slice={1}
              pollIntervalMs={iterativePollMs}
            />
          </>
        )}
        {probePath && (
          <>
            <TiledImageTile
              title="Probe |·|"
              path={probePath}
              slice={0}
              pollIntervalMs={iterativePollMs}
              onChanged={handleProbeChanged}
            />
            <TiledImageTile
              title="Probe phase"
              path={probePath}
              slice={1}
              pollIntervalMs={iterativePollMs}
            />
          </>
        )}
        {sources.hasVitAmp && (
          <TiledImageTile
            title="ViT mosaic (amp)"
            subtitle={vitBatch !== null ? `batch ${vitBatch}` : undefined}
            path={`${path}/vit/mosaic_amp`}
            slice=":,:"
            pollIntervalMs={vitPollMs}
          />
        )}
        {sources.hasVit && (
          <TiledImageTile
            title="ViT mosaic (phase)"
            subtitle={vitBatch !== null ? `batch ${vitBatch}` : undefined}
            path={`${path}/vit/mosaic`}
            slice=":,:"
            pollIntervalMs={vitPollMs}
            onChanged={handleVitChanged}
          />
        )}
        {sources.hasDiffraction && latestFrameIdx !== null && displayFrameIdx !== null && (
          <div className="flex flex-col col-span-2">
            <div className={`grid ${sources.hasInference ? 'grid-cols-3' : 'grid-cols-1'} gap-3`}>
              <TiledImageTile
                title="Detector frame"
                subtitle={(() => {
                  const scanFrame = displayFrameIdx * dpStride;
                  const latestScan = latestFrameIdx * dpStride;
                  const strideNote = dpStride > 1 ? ` · every ${dpStride}` : '';
                  return isFollowingLatest
                    ? `${scanFrame} (latest)${strideNote}`
                    : `${scanFrame} / ${latestScan}${strideNote}`;
                })()}
                path={`${path}/diffraction/dp`}
                slice={displayFrameIdx}
                // Only poll while we're tracking the latest. When the user
                // has scrubbed to an older frame, that frame doesn't change,
                // so polling just wastes round-trips.
                pollIntervalMs={isFollowingLatest ? POLL_INTERVAL_MS : 0}
                onChanged={handleFrameChanged}
              />
              {/* ViT patch tiles only exist when the ViT branch ran — hidden on
                  iterative-only scans (no diffraction/inference array). */}
              {sources.hasInference && (
                <>
                  <TiledImageTile
                    title="ViT patch (amp)"
                    subtitle={`frame ${displayFrameIdx * dpStride}`}
                    path={`${path}/diffraction/inference`}
                    slice={`${displayFrameIdx},0`}
                    pollIntervalMs={isFollowingLatest ? POLL_INTERVAL_MS : 0}
                  />
                  <TiledImageTile
                    title="ViT patch (phase)"
                    subtitle={`frame ${displayFrameIdx * dpStride}`}
                    path={`${path}/diffraction/inference`}
                    slice={`${displayFrameIdx},1`}
                    pollIntervalMs={isFollowingLatest ? POLL_INTERVAL_MS : 0}
                  />
                </>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 px-1">
              <input
                type="range"
                min={0}
                max={latestFrameIdx}
                step={1}
                value={displayFrameIdx}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  // Snap-to-latest when the user drags to the rightmost end.
                  setSelectedFrameIdx(v >= latestFrameIdx ? null : v);
                }}
                aria-label="Detector frame index"
                className="flex-1 accent-beam"
              />
              {!isFollowingLatest && (
                <button
                  type="button"
                  onClick={() => setSelectedFrameIdx(null)}
                  className="text-[10px] uppercase tracking-wider text-beam hover:text-beam-hover px-2 py-0.5 rounded border border-beam/40 hover:bg-beam/10"
                >
                  Follow
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-raised/50 border border-border-subtle text-[11px] font-mono">
        {containerMeta?.scan_id !== undefined && (
          <span className="flex items-center gap-1 text-text-secondary">
            <Hash className="w-3 h-3 text-beam" />
            {containerMeta.scan_id}
          </span>
        )}
        {containerMeta?.recon_mode && (
          <span className="flex items-center gap-1 text-text-secondary">
            <Activity className="w-3 h-3 text-cell" />
            {containerMeta.recon_mode}
          </span>
        )}
        {sources.iterativeSource === 'live' && (
          <span className="ml-auto text-text-tertiary">
            updated {formatRelative(lastUpdateAt)}
          </span>
        )}
        {sources.iterativeSource === 'final' && (
          <span className="ml-auto text-text-tertiary">final</span>
        )}
      </div>
    </div>
  );
}
