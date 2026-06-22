'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { Loader2, Hash, Activity } from 'lucide-react';
import {
  fetchArrayInfo,
  fetchArrayBytesIfChanged,
  listChildren,
  getMetadata,
  type ArrayInfo,
} from '@/lib/tiled/client';
import { paintFloatArrayToCanvas, type ViewRect } from '@/lib/tiled/colormap';
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
    return { iterativeSource, hasVit, hasVitAmp, hasDiffraction: ids.has('diffraction') };
  } catch {
    return { iterativeSource: null, hasVit: false, hasVitAmp: false, hasDiffraction: false };
  }
}

// Viridis gradient stops for the colorbar SVG (matches VIRIDIS_LUT endpoints).
const VIRIDIS_GRADIENT_STOPS = [
  { offset: 0, color: 'rgb(68,1,84)' },
  { offset: 0.25, color: 'rgb(59,82,139)' },
  { offset: 0.5, color: 'rgb(33,145,140)' },
  { offset: 0.75, color: 'rgb(94,201,98)' },
  { offset: 1, color: 'rgb(253,231,37)' },
];

// Compact numeric formatter for axis/colorbar labels: 3 significant figures,
// using exponential notation for very large/small magnitudes.
function formatTick(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 10000 || abs < 0.001) return v.toExponential(2);
  return Number(v.toPrecision(3)).toString();
}

// Pixel-axis tick step for the un-zoomed (full) view.
const AXIS_TICK_STEP = 100;

// Pick a "nice" tick step (1/2/5 × 10^k) targeting ~5 intervals across `span`.
// Used when zoomed in, where a fixed 100-px step would be too coarse or fine.
function niceStep(span: number): number {
  const raw = span / 5;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const snapped = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return Math.max(1, snapped * mag);
}

// Generate axis ticks across the pixel range [start, end]. At full zoom the
// step is AXIS_TICK_STEP (100 px); when zoomed in it adapts to the span. Each
// tick carries its pixel value and fractional position (0–1) along the axis.
function axisTicks(start: number, end: number, fullSpan: number): { value: number; frac: number }[] {
  const span = end - start;
  if (!Number.isFinite(span) || span <= 0) return [{ value: Math.round(start), frac: 0 }];
  const step = span >= fullSpan * 0.999 ? AXIS_TICK_STEP : niceStep(span);
  const ticks: { value: number; frac: number }[] = [];
  const first = Math.ceil(start / step) * step;
  for (let v = first; v <= end + 1e-6; v += step) {
    ticks.push({ value: Math.round(v), frac: (v - start) / span });
  }
  if (ticks.length === 0) ticks.push({ value: Math.round(start), frac: 0 });
  return ticks;
}

interface DecoratedImageTileProps {
  title: string;
  subtitle?: string;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  render: {
    min: number;
    max: number;
    x0: number;
    y0: number;
    width: number;
    height: number;
    fullWidth: number;
    fullHeight: number;
  } | null;
  hasLoadedOnce: boolean;
  error: string | null;
  isZoomed: boolean;
  // Drag-selected a region (display coords) to zoom into.
  onZoom: (rect: ViewRect) => void;
  onResetZoom: () => void;
}

// A normalized drag rectangle (0–1) within the image box, used to render the
// live selection overlay while the user drags.
interface DragRect { x0: number; y0: number; x1: number; y1: number }

// Wraps the bare canvas with pixel-index x/y axes (ticked every 100 px at full
// zoom) and a numeric viridis colorbar. The image box is sized to the rendered
// aspect ratio so the canvas fills it exactly and ticks line up with the image
// bounds. The x-axis sits in a mirrored row below so the main row's height
// equals the image height, keeping the y-axis and colorbar aligned to the image.
//
// Drag a rectangle over the image to zoom in; the contrast then autoscales to
// the central 50% of the new view. A reset control restores the full image.
function DecoratedImageTile({
  title,
  subtitle,
  canvasRef,
  render,
  hasLoadedOnce,
  error,
  isZoomed,
  onZoom,
  onResetZoom,
}: DecoratedImageTileProps) {
  const imageBoxRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);

  // Normalized (0–1) pointer position within the image box.
  const normFromEvent = (e: React.PointerEvent): { x: number; y: number } | null => {
    const box = imageBoxRef.current;
    if (!box) return null;
    const r = box.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!render) return;
    const p = normFromEvent(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = p;
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    const p = normFromEvent(e);
    if (!p) return;
    setDrag({ x0: dragStartRef.current.x, y0: dragStartRef.current.y, x1: p.x, y1: p.y });
  };

  const handlePointerUp = () => {
    const d = drag;
    dragStartRef.current = null;
    setDrag(null);
    if (!d || !render) return;
    const nx0 = Math.min(d.x0, d.x1);
    const nx1 = Math.max(d.x0, d.x1);
    const ny0 = Math.min(d.y0, d.y1);
    const ny1 = Math.max(d.y0, d.y1);
    // Ignore tiny selections (treat as a click, not a zoom).
    if (nx1 - nx0 < 0.03 || ny1 - ny0 < 0.03) return;
    // Map the normalized selection within the current view to display coords.
    onZoom({
      x0: render.x0 + nx0 * render.width,
      y0: render.y0 + ny0 * render.height,
      x1: render.x0 + nx1 * render.width,
      y1: render.y0 + ny1 * render.height,
    });
  };

  const w = render?.width ?? 1;
  const h = render?.height ?? 1;
  const aspect = render ? w / h : 1;
  const xTicks = render ? axisTicks(render.x0, render.x0 + render.width, render.fullWidth) : [];
  // y is in image coordinates: row 0 at the top, increasing downward.
  const yTicks = render ? axisTicks(render.y0, render.y0 + render.height, render.fullHeight) : [];
  const gradId = `cbar-${title.replace(/[^a-z0-9]/gi, '')}`;

  const sel = drag && {
    left: `${Math.min(drag.x0, drag.x1) * 100}%`,
    top: `${Math.min(drag.y0, drag.y1) * 100}%`,
    width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
    height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-medium">{title}</span>
        {subtitle && <span className="text-[10px] text-text-tertiary font-mono">{subtitle}</span>}
      </div>

      {/* main row: y-axis | image | colorbar gradient | colorbar labels.
          The image box is the tallest child, so items-stretch makes the others
          match its height. */}
      <div className="flex items-stretch gap-1">
        {/* y-axis ticks, absolutely placed by pixel fraction */}
        <div className="relative w-10 shrink-0 text-[16px] font-mono text-text-primary leading-none">
          {render && yTicks.map((t) => {
            const top = t.frac <= 0.02 ? '0%' : t.frac >= 0.98 ? '100%' : `${t.frac * 100}%`;
            const ty = t.frac <= 0.02 ? '0' : t.frac >= 0.98 ? '-100%' : '-50%';
            return (
              <span
                key={t.value}
                className="absolute right-0 whitespace-nowrap"
                style={{ top, transform: `translateY(${ty})` }}
              >
                {t.value}
              </span>
            );
          })}
        </div>

        {/* image box — drag to zoom */}
        <div
          ref={imageBoxRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="flex-1 min-w-0 relative rounded-lg overflow-hidden bg-surface-raised border border-border-subtle cursor-crosshair touch-none select-none"
          style={{ aspectRatio: String(aspect) }}
        >
          <canvas
            ref={canvasRef}
            aria-label={title}
            className="w-full h-full object-contain pointer-events-none"
            style={{ imageRendering: 'pixelated' }}
          />
          {sel && (
            <div
              className="absolute border border-beam bg-beam/15 pointer-events-none"
              style={sel}
            />
          )}
          {isZoomed && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onResetZoom}
              className="absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded bg-surface-ground/85 border border-beam/40 text-[10px] uppercase tracking-wider text-beam hover:bg-beam/10"
            >
              Reset
            </button>
          )}
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

        {/* colorbar gradient */}
        <div className="w-3 shrink-0 self-stretch rounded-sm overflow-hidden border border-border-subtle">
          <svg width="100%" height="100%" preserveAspectRatio="none" className="block w-full h-full">
            <defs>
              <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
                {VIRIDIS_GRADIENT_STOPS.map((s) => (
                  <stop key={s.offset} offset={`${s.offset * 100}%`} stopColor={s.color} />
                ))}
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradId})`} />
          </svg>
        </div>
        {/* colorbar labels (max top → min bottom) */}
        <div className="flex flex-col justify-between items-start w-12 shrink-0 text-[16px] font-mono text-text-primary leading-none">
          <span>{render ? formatTick(render.max) : '—'}</span>
          <span>{render ? formatTick((render.min + render.max) / 2) : ''}</span>
          <span>{render ? formatTick(render.min) : '—'}</span>
        </div>
      </div>

      {/* x-axis row, mirrors the main row's column widths so ticks align under
          the image box */}
      <div className="flex gap-1 mt-0.5">
        <div className="w-10 shrink-0" />
        <div className="flex-1 relative h-5 text-[16px] font-mono text-text-primary leading-none">
          {render && xTicks.map((t) => {
            const left = t.frac <= 0.02 ? '0%' : t.frac >= 0.98 ? '100%' : `${t.frac * 100}%`;
            const tx = t.frac <= 0.02 ? '0' : t.frac >= 0.98 ? '-100%' : '-50%';
            return (
              <span
                key={t.value}
                className="absolute top-0"
                style={{ left, transform: `translateX(${tx})` }}
              >
                {t.value}
              </span>
            );
          })}
        </div>
        <div className="w-3 shrink-0" />
        <div className="w-12 shrink-0" />
      </div>

      {/* px unit label, centered under the image box */}
      <div className="flex gap-1">
        <div className="w-10 shrink-0" />
        <div className="flex-1 text-center text-[16px] uppercase tracking-wider text-text-secondary">px</div>
        <div className="w-3 shrink-0" />
        <div className="w-12 shrink-0" />
      </div>
    </div>
  );
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
  // Anti-transpose the rendered image (reflect across the anti-diagonal).
  // Applied in the pixel painter so non-square mosaics keep correct dimensions.
  antiTranspose?: boolean;
  // Draw pixel-index x/y axes around the image and a numeric colorbar showing
  // the display range. Used for the ViT mosaics.
  decorated?: boolean;
}

function TiledImageTile({
  title,
  subtitle,
  path,
  slice,
  pollIntervalMs,
  onChanged,
  antiTranspose = false,
  decorated = false,
}: TiledImageTileProps) {
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Display range + rendered view (origin/size in display coords) + full
  // display dimensions from the last paint — drives the colorbar labels, axis
  // tick ranges and zoom clamping (only used when `decorated`).
  const [render, setRender] = useState<
    {
      min: number;
      max: number;
      x0: number;
      y0: number;
      width: number;
      height: number;
      fullWidth: number;
      fullHeight: number;
    } | null
  >(null);
  // Current zoom rectangle in display coords, or null for the full image.
  const [view, setView] = useState<ViewRect | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onChangedRef = useRef(onChanged);
  // Latest decoded frame, kept so zoom changes can repaint without refetching.
  const dataRef = useRef<{
    data: Float32Array | Float64Array | Uint16Array | Uint8Array;
    w: number;
    h: number;
  } | null>(null);
  const viewRef = useRef<ViewRect | null>(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  // Repaint the current frame at the given view. Used both by the polling loop
  // (fresh data) and on zoom changes (same data, new crop + autoscale).
  const paint = useCallback((v: ViewRect | null) => {
    const d = dataRef.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const r = paintFloatArrayToCanvas(canvas, d.data, d.w, d.h, antiTranspose, v ?? undefined);
    setRender({
      min: r.min, max: r.max,
      x0: r.x0, y0: r.y0, width: r.width, height: r.height,
      fullWidth: r.fullWidth, fullHeight: r.fullHeight,
    });
  }, [antiTranspose]);
  const paintRef = useRef(paint);
  useEffect(() => { paintRef.current = paint; }, [paint]);

  // Repaint when the zoom view changes (no refetch needed).
  useEffect(() => { paint(view); }, [view, paint]);

  // Reset zoom whenever the underlying array changes.
  useEffect(() => { setView(null); }, [path, slice]);

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
        dataRef.current = { data, w, h };
        paintRef.current(viewRef.current);
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
  }, [path, slice, pollIntervalMs, antiTranspose]);

  // Decorated tiles (the ViT mosaics) get pixel-index x/y axes and a numeric
  // colorbar; everything else renders just the bare canvas.
  if (decorated) {
    return (
      <DecoratedImageTile
        title={title}
        subtitle={subtitle}
        canvasRef={canvasRef}
        render={render}
        hasLoadedOnce={hasLoadedOnce}
        error={error}
        isZoomed={view !== null}
        onZoom={setView}
        onResetZoom={() => setView(null)}
      />
    );
  }

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
          style={{ imageRendering: 'pixelated' }}
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
  const [sources, setSources] = useState<SourceInfo>({ iterativeSource: null, hasVit: false, hasVitAmp: false, hasDiffraction: false });
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
            antiTranspose
            decorated
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
            antiTranspose
            decorated
          />
        )}
        {sources.hasDiffraction && latestFrameIdx !== null && displayFrameIdx !== null && (
          <div className="flex flex-col col-span-2">
            <div className="grid grid-cols-3 gap-3">
              <TiledImageTile
                title="Detector frame"
                subtitle={(() => {
                  const scanFrame = displayFrameIdx * dpStride;
                  const latestScan = latestFrameIdx * dpStride;
                  const strideNote = dpStride > 1 ? ` · 1 of every ${dpStride} frames` : '';
                  return isFollowingLatest
                    ? `frame ${scanFrame} (latest)${strideNote}`
                    : `frame ${scanFrame} / ${latestScan}${strideNote}`;
                })()}
                path={`${path}/diffraction/dp`}
                slice={displayFrameIdx}
                // Only poll while we're tracking the latest. When the user
                // has scrubbed to an older frame, that frame doesn't change,
                // so polling just wastes round-trips.
                pollIntervalMs={isFollowingLatest ? POLL_INTERVAL_MS : 0}
                onChanged={handleFrameChanged}
              />
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
