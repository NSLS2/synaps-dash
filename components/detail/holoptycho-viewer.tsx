'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import { Loader2, Hash, Activity, Eye, EyeOff } from 'lucide-react';
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
  // Whether vit/segmentation_mask is available (DP-relative blob mask overlaid
  // on the detector frame). Absent on runs written before segmentation landed.
  hasVitSegMask: boolean;
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

// Inner-crop rectangle (the region kept and stitched into the mosaic), written
// by the holoptycho pipeline onto the run container's metadata as:
//   patch_crop_box: [[y0, x0], [y1, x1]]   // top-left, bottom-right
// Coordinates are integer (row, col) in the patch's own pixel frame — the same
// frame as the plotted amp/phase patch arrays — so the overlay maps directly
// with no scaling. Returns null for anything missing or malformed so the GUI
// simply skips drawing the box rather than crashing.
interface CropBox { y0: number; x0: number; y1: number; x1: number }

function parseCropBox(raw: unknown): CropBox | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [tl, br] = raw;
  if (!Array.isArray(tl) || !Array.isArray(br) || tl.length < 2 || br.length < 2) return null;
  const [y0, x0] = tl;
  const [y1, x1] = br;
  if (![y0, x0, y1, x1].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (x1 <= x0 || y1 <= y0) return null;
  return { y0, x0, y1, x1 };
}

// A labeled rectangle overlay, positioned as a fraction of the full image
// dimensions. Box coords are in the image's own (row, col) pixel frame — the
// same frame as the plotted array — so they map directly with no scaling. The
// arrays here are square and fill their aspect-square box via object-contain,
// so percentages line up 1:1.
function LabeledBox({
  box,
  fullWidth,
  fullHeight,
  label,
}: {
  box: CropBox;
  fullWidth: number;
  fullHeight: number;
  label: string;
}) {
  if (!(fullWidth > 0) || !(fullHeight > 0)) return null;
  return (
    <div
      className="absolute border border-white pointer-events-none"
      style={{
        left: `${(box.x0 / fullWidth) * 100}%`,
        top: `${(box.y0 / fullHeight) * 100}%`,
        width: `${((box.x1 - box.x0) / fullWidth) * 100}%`,
        height: `${((box.y1 - box.y0) / fullHeight) * 100}%`,
      }}
    >
      <span className="absolute left-0 top-0 px-1 py-0.5 leading-none text-[9px] font-mono whitespace-nowrap text-white bg-surface-ground/80 rounded-br">
        {label}
      </span>
    </div>
  );
}

// Segmentation blob colour (nova pink) — contrasts with the viridis diffraction
// background and the white box/crosshair. Last value is the per-pixel alpha.
const MASK_RGBA: [number, number, number, number] = [244, 114, 182, 130];

// Paint a uint8 (ny, nx) blob mask into `canvas` at native resolution: nonzero
// pixels get the translucent highlight colour, zeros stay fully transparent.
function paintMaskToCanvas(canvas: HTMLCanvasElement, data: Uint8Array, w: number, h: number) {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const imageData = ctx.createImageData(w, h);
  const out = imageData.data;
  const [r, g, b, a] = MASK_RGBA;
  for (let i = 0; i < w * h && i < data.length; i++) {
    if (data[i] !== 0) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = a;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

// Translucent overlay of a DP-relative segmentation mask, layered over the
// detector-frame canvas. The mask shares the detector frame's pixel grid, so it
// lines up 1:1 (no scaling) when both fill the same aspect-square box. Fetches +
// polls independently; silently renders nothing if the array is missing.
function MaskOverlay({ path, pollIntervalMs }: { path: string; pollIntervalMs?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let etag: string | null = null;
    let inflight = false;
    let shape: [number, number] | null = null;

    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        if (!shape) {
          const info = await fetchArrayInfo(path).catch(() => null);
          const s = info ? deriveDisplayShape(info.shape) : null;
          if (!s) return;
          shape = s;
        }
        const result = await fetchArrayBytesIfChanged(path, ':,:', etag);
        if (cancelled || result.status === 'unchanged' || result.status === 'error') return;
        etag = result.etag;
        const [h, w] = shape;
        const data = new Uint8Array(result.buffer);
        const canvas = canvasRef.current;
        if (!canvas || data.length < w * h) return;
        paintMaskToCanvas(canvas, data, w, h);
      } finally {
        inflight = false;
      }
    };

    tick();
    if (!pollIntervalMs) return () => { cancelled = true; };
    const handle = setInterval(tick, pollIntervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [path, pollIntervalMs]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
    />
  );
}

async function discoverSources(runPath: string): Promise<SourceInfo> {
  try {
    const children = await listChildren(runPath, { limit: 10, noCache: true });
    const ids = new Set(children.items.map(c => c.id));
    const iterativeSource = ids.has('live') ? 'live' : ids.has('final') ? 'final' : null;
    const hasVit = ids.has('vit');
    let hasVitAmp = false;
    let hasVitSegMask = false;
    if (hasVit) {
      try {
        const vitChildren = await listChildren(`${runPath}/vit`, { limit: 20, noCache: true });
        hasVitAmp = vitChildren.items.some(c => c.id === 'mosaic_amp');
        hasVitSegMask = vitChildren.items.some(c => c.id === 'segmentation_mask');
      } catch { /* absent on older runs */ }
    }
    return { iterativeSource, hasVit, hasVitAmp, hasVitSegMask, hasDiffraction: ids.has('diffraction') };
  } catch {
    return { iterativeSource: null, hasVit: false, hasVitAmp: false, hasVitSegMask: false, hasDiffraction: false };
  }
}

// True when two discovery snapshots are identical — lets the poller avoid
// pointless state updates / re-renders when nothing new has appeared.
function sameSources(a: SourceInfo, b: SourceInfo): boolean {
  return (
    a.iterativeSource === b.iterativeSource &&
    a.hasVit === b.hasVit &&
    a.hasVitAmp === b.hasVitAmp &&
    a.hasVitSegMask === b.hasVitSegMask &&
    a.hasDiffraction === b.hasDiffraction
  );
}

// Merge a fresh discovery snapshot into the previous one monotonically. Sub-
// containers/arrays only ever appear during a run, so a flag that was already
// true must stay true even if a transient (failed/empty) poll comes back blank.
// Without this, a momentary listing hiccup would unmount tiles and reset
// dependent state — notably the frame-follow high-water in useLatestFilledIndex,
// which made the detector-frame slider jump back to the start.
function mergeSources(prev: SourceInfo, next: SourceInfo): SourceInfo {
  return {
    iterativeSource: next.iterativeSource ?? prev.iterativeSource,
    hasVit: prev.hasVit || next.hasVit,
    hasVitAmp: prev.hasVitAmp || next.hasVitAmp,
    hasVitSegMask: prev.hasVitSegMask || next.hasVitSegMask,
    hasDiffraction: prev.hasDiffraction || next.hasDiffraction,
  };
}

const EMPTY_SOURCES: SourceInfo = {
  iterativeSource: null,
  hasVit: false,
  hasVitAmp: false,
  hasVitSegMask: false,
  hasDiffraction: false,
};

// Cadence for re-checking which sub-containers/arrays exist, so new plots show
// up on their own while a run is still being written.
const DISCOVERY_POLL_MS = 3000;

// Poll a mosaic array's shape to support both single mosaics and stacks. A 2D
// (H, W) array is a single mosaic; a 3D (N, H, W) array is a stack of N mosaics
// that grows while a run is live. Returns the (monotonic) count and whether it
// is stacked, or null until the shape is first known.
function useMosaicStack(
  path: string,
  pollIntervalMs: number,
): { count: number; stacked: boolean } | null {
  const [stack, setStack] = useState<{ count: number; stacked: boolean } | null>(null);

  useEffect(() => {
    setStack(null);
    if (!path) return;
    let cancelled = false;
    let inflight = false;
    let hi = 0;

    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      try {
        const info = await fetchArrayInfo(path).catch(() => null);
        // TEMP DIAGNOSTIC — remove once the mosaic slider is confirmed working.
        console.log('[useMosaicStack]', path, 'shape=', info?.shape);
        if (!info || cancelled || info.shape.length < 2) return;
        const stacked = info.shape.length >= 3;
        const count = stacked ? info.shape[0] : 1;
        if (count < hi) return; // monotonic — never shrink mid-run
        hi = count;
        setStack(prev =>
          prev && prev.count === count && prev.stacked === stacked ? prev : { count, stacked },
        );
      } finally {
        inflight = false;
      }
    };

    tick();
    if (!pollIntervalMs) return () => { cancelled = true; };
    const handle = setInterval(tick, pollIntervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [path, pollIntervalMs]);

  return stack;
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
  // Optional LOG-scale toggle shown on the image.
  allowLogScale?: boolean;
  logScale?: boolean;
  onToggleLog?: () => void;
}

// A normalized drag rectangle (0–1) within the image box, used to render the
// live selection overlay while the user drags.
interface DragRect { x0: number; y0: number; x1: number; y1: number }

// Small overlay toggle for log-scale display. `stopPropagation` on pointer-down
// keeps a click from starting a zoom drag on the decorated tiles.
function LogToggle({ active, onToggle, className }: { active: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
      aria-pressed={active}
      title="Toggle log scale"
      className={`z-10 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${
        active
          ? 'bg-beam/20 border-beam/60 text-beam'
          : 'bg-surface-ground/85 border-border-subtle text-text-tertiary hover:text-text-secondary'
      } ${className ?? ''}`}
    >
      log
    </button>
  );
}

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
  allowLogScale = false,
  logScale = false,
  onToggleLog,
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
            // Slight extra softening on top of the browser's bilinear upscale.
            // Bump the px value for more smoothing, drop to 0/remove for none.
          />
          {sel && (
            <div
              className="absolute border border-beam bg-beam/15 pointer-events-none"
              style={sel}
            />
          )}
          {allowLogScale && onToggleLog && (
            <LogToggle active={logScale} onToggle={onToggleLog} className="absolute top-1 left-1" />
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
  // Rotate the rendered image 90° counter-clockwise. Applied in the pixel
  // painter so non-square mosaics keep correct dimensions.
  rotateCCW?: boolean;
  // Draw pixel-index x/y axes around the image and a numeric colorbar showing
  // the display range. Used for the ViT mosaics.
  decorated?: boolean;
  // Optional inner-crop rectangle (patch-pixel coords) to overlay on the image.
  // Used by the ViT amp/phase patch tiles to show what's kept before stitching.
  cropBox?: CropBox | null;
  // Optional segmentation rectangle (detector-pixel coords) to overlay on the
  // image. Used by the detector-frame tile.
  segBox?: CropBox | null;
  // Optional path to a DP-relative segmentation mask array to overlay as a
  // translucent blob on top of the image. Used by the detector-frame tile.
  maskPath?: string;
  // Draw horizontal + vertical lines through the image center (e.g. to mark the
  // detector center on the diffraction frame).
  centerAxes?: boolean;
  // Show a LOG toggle on the image that log-compresses values (log10(v+1))
  // before contrast + colormapping. Useful for high-dynamic-range data
  // (detector frames, mosaics).
  allowLogScale?: boolean;
}

function TiledImageTile({
  title,
  subtitle,
  path,
  slice,
  pollIntervalMs,
  onChanged,
  rotateCCW = false,
  decorated = false,
  cropBox,
  segBox,
  maskPath,
  centerAxes = false,
  allowLogScale = false,
}: TiledImageTileProps) {
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether to log-compress the displayed values (toggled via the LOG button).
  const [logScale, setLogScale] = useState(false);
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
    const r = paintFloatArrayToCanvas(canvas, d.data, d.w, d.h, rotateCCW, v ?? undefined, logScale);
    setRender({
      min: r.min, max: r.max,
      x0: r.x0, y0: r.y0, width: r.width, height: r.height,
      fullWidth: r.fullWidth, fullHeight: r.fullHeight,
    });
  }, [rotateCCW, logScale]);
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
  }, [path, slice, pollIntervalMs, rotateCCW]);

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
        allowLogScale={allowLogScale}
        logScale={logScale}
        onToggleLog={() => setLogScale((s) => !s)}
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
        />
        {/* Translucent segmentation blob, layered between the image and the
            box/crosshair overlays. */}
        {maskPath && <MaskOverlay path={maskPath} pollIntervalMs={pollIntervalMs} />}
        {/* Inner-crop rectangle (ViT patch tiles) and segmentation rectangle
            (detector-frame tile), drawn from metadata in the array's own pixel
            frame. */}
        {cropBox && render && (
          <LabeledBox
            box={cropBox}
            fullWidth={render.fullWidth}
            fullHeight={render.fullHeight}
            label={`crop ${cropBox.x1 - cropBox.x0}×${cropBox.y1 - cropBox.y0}`}
          />
        )}
        {segBox && render && (
          <LabeledBox
            box={segBox}
            fullWidth={render.fullWidth}
            fullHeight={render.fullHeight}
            label={`seg ${segBox.x1 - segBox.x0}×${segBox.y1 - segBox.y0}`}
          />
        )}
        {/* Center crosshair — horizontal + vertical lines through the image
            center. Square arrays in this aspect-square box via object-contain,
            so 50% lands on the true center. Inline styles avoid relying on
            Tailwind utilities (w-px etc.) that could collapse the lines. */}
        {centerAxes && (
          <>
            <div
              className="absolute pointer-events-none z-10"
              style={{ top: 0, bottom: 0, left: '50%', width: '1px', marginLeft: '-0.5px', backgroundColor: 'rgba(255,255,255,0.85)', boxShadow: '0 0 1.5px rgba(0,0,0,0.9)' }}
            />
            <div
              className="absolute pointer-events-none z-10"
              style={{ left: 0, right: 0, top: '50%', height: '1px', marginTop: '-0.5px', backgroundColor: 'rgba(255,255,255,0.85)', boxShadow: '0 0 1.5px rgba(0,0,0,0.9)' }}
            />
          </>
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
        {allowLogScale && (
          <LogToggle active={logScale} onToggle={() => setLogScale((s) => !s)} className="absolute top-1 left-1" />
        )}
      </div>
    </div>
  );
}

export function HoloptychoViewer({ path, metadata }: HoloptychoViewerProps) {
  const [sources, setSources] = useState<SourceInfo>(EMPTY_SOURCES);
  // Toggle for the segmentation mask overlay on the detector frame.
  const [showMask, setShowMask] = useState(true);
  const [isDiscovering, setIsDiscovering] = useState(true);
  // Live copy of the run-container metadata. The `metadata` prop is the listing
  // snapshot from when the item was selected, so fields the pipeline writes
  // mid-run (patch_crop_box, segmentation_box, …) aren't there yet. We poll the
  // metadata endpoint so those overlays appear without a manual refresh.
  const [liveMeta, setLiveMeta] = useState<Record<string, unknown> | null>(null);
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

  const containerMeta = (liveMeta ?? metadata) as {
    scan_id?: number | string;
    recon_mode?: string;
    run_uid?: string;
    dp_stride?: number;
    patch_crop_box?: unknown;
    segmentation_box?: unknown;
  } | undefined;
  // Inner-crop rectangle drawn on the ViT amp/phase patch tiles. Absent on runs
  // written before holoptycho started recording it → parseCropBox returns null
  // and the overlay is simply skipped.
  const patchCropBox = parseCropBox(containerMeta?.patch_crop_box);
  // Segmentation rectangle drawn on the detector-frame tile (same format,
  // detector-pixel coords). Skipped when absent/malformed.
  const segBox = parseCropBox(containerMeta?.segmentation_box);
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

  // Mosaic stack: one shared slider drives the index for both the amp and phase
  // mosaics. Probe the phase mosaic (or amp, whichever exists) for the count.
  const mosaicProbePath = sources.hasVit
    ? `${path}/vit/mosaic`
    : sources.hasVitAmp
      ? `${path}/vit/mosaic_amp`
      : '';
  const mosaicStack = useMosaicStack(
    mosaicProbePath,
    sources.iterativeSource === 'live' || !sources.iterativeSource ? POLL_INTERVAL_MS : 0,
  );
  const [selectedMosaicIdx, setSelectedMosaicIdx] = useState<number | null>(null);
  const mosaicCount = mosaicStack?.count ?? null;
  const mosaicStacked = mosaicStack?.stacked ?? false;
  const latestMosaicIdx = mosaicCount !== null ? mosaicCount - 1 : null;
  const displayMosaicIdx = selectedMosaicIdx !== null ? selectedMosaicIdx : latestMosaicIdx;
  const isFollowingLatestMosaic = selectedMosaicIdx === null;

  // Poll the run-container metadata so overlay fields written mid-run
  // (patch_crop_box, segmentation_box) show up without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    let inflight = false;
    setLiveMeta(null);
    const tick = () => {
      if (inflight) return;
      inflight = true;
      getMetadata(path)
        .then(m => { if (!cancelled) setLiveMeta(m); })
        .catch(() => { /* keep last known / fall back to prop */ })
        .finally(() => { inflight = false; });
    };
    tick();
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(handle); };
  }, [path]);

  // Initial discovery: figure out which sub-containers exist on this run.
  // Reset to empty first so switching datasets doesn't carry over (or merge
  // against) the previous run's flags.
  useEffect(() => {
    let cancelled = false;
    setIsDiscovering(true);
    setSources(EMPTY_SOURCES);
    setIteration(null);
    setVitBatch(null);
    setSelectedFrameIdx(null);
    setSelectedMosaicIdx(null);
    discoverSources(path).then(result => {
      if (cancelled) return;
      setSources(result);
      setIsDiscovering(false);
    });
    return () => { cancelled = true; };
  }, [path]);

  // Re-discover on a timer so plots that get written partway through a run
  // (live/, vit/, diffraction/, the mosaics, the segmentation mask, …) appear
  // on their own — no need to reselect the dataset to force a refresh. Uses
  // fresh (uncached) listings and merges monotonically so a transient empty
  // poll never makes existing tiles disappear.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      discoverSources(path).then(result => {
        if (cancelled) return;
        setSources(prev => {
          const merged = mergeSources(prev, result);
          return sameSources(prev, merged) ? prev : merged;
        });
      });
    };
    const handle = setInterval(refresh, DISCOVERY_POLL_MS);
    return () => { cancelled = true; clearInterval(handle); };
  }, [path]);

  // WebSocket subscription on the run container picks up newly-created sub-containers
  // (e.g. live/ appears partway through a run). We re-run discovery on creation.
  const handleNewItem = useCallback(() => {
    discoverSources(path).then(result => {
      setSources(prev => {
        const merged = mergeSources(prev, result);
        return sameSources(prev, merged) ? prev : merged;
      });
    });
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

  // Slice for the mosaic tiles: a single 2D mosaic is `:,:`; a 3D stack selects
  // the current index off the leading axis.
  const mosaicSlice = mosaicStacked && displayMosaicIdx !== null
    ? `${displayMosaicIdx},:,:`
    : ':,:';

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
        {(sources.hasVit || sources.hasVitAmp) && (
          <div className="flex flex-col col-span-2">
            <div className="grid grid-cols-2 gap-3">
              {sources.hasVitAmp && (
                <TiledImageTile
                  title="ViT mosaic (amp)"
                  subtitle={vitBatch !== null ? `batch ${vitBatch}` : undefined}
                  path={`${path}/vit/mosaic_amp`}
                  slice={mosaicSlice}
                  pollIntervalMs={vitPollMs}
                  rotateCCW
                  decorated
                  allowLogScale
                />
              )}
              {sources.hasVit && (
                <TiledImageTile
                  title="ViT mosaic (phase)"
                  subtitle={vitBatch !== null ? `batch ${vitBatch}` : undefined}
                  path={`${path}/vit/mosaic`}
                  slice={mosaicSlice}
                  pollIntervalMs={vitPollMs}
                  onChanged={handleVitChanged}
                  rotateCCW
                  decorated
                  allowLogScale
                />
              )}
            </div>
            {mosaicStacked && mosaicCount !== null && mosaicCount > 1 && latestMosaicIdx !== null && displayMosaicIdx !== null && (
              <div className="flex items-center gap-2 mt-2 px-1">
                <span className="text-xs text-text-secondary font-mono whitespace-nowrap min-w-[90px] text-center">
                  mosaic {displayMosaicIdx + 1} / {mosaicCount}
                </span>
                <input
                  type="range"
                  min={0}
                  max={latestMosaicIdx}
                  step={1}
                  value={displayMosaicIdx}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    // Snap-to-latest when dragged to the rightmost end.
                    setSelectedMosaicIdx(v >= latestMosaicIdx ? null : v);
                  }}
                  aria-label="Mosaic index"
                  className="flex-1 accent-beam"
                />
                {!isFollowingLatestMosaic && (
                  <button
                    type="button"
                    onClick={() => setSelectedMosaicIdx(null)}
                    className="text-[10px] uppercase tracking-wider text-beam hover:text-beam-hover px-2 py-0.5 rounded border border-beam/40 hover:bg-beam/10"
                  >
                    Follow
                  </button>
                )}
              </div>
            )}
          </div>
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
                centerAxes
                segBox={segBox}
                maskPath={showMask && sources.hasVitSegMask ? `${path}/vit/segmentation_mask` : undefined}
                allowLogScale
              />
              <TiledImageTile
                title="ViT patch (amp)"
                subtitle={`frame ${displayFrameIdx * dpStride}`}
                path={`${path}/diffraction/inference`}
                slice={`${displayFrameIdx},0`}
                pollIntervalMs={isFollowingLatest ? POLL_INTERVAL_MS : 0}
                cropBox={patchCropBox}
                centerAxes
              />
              <TiledImageTile
                title="ViT patch (phase)"
                subtitle={`frame ${displayFrameIdx * dpStride}`}
                path={`${path}/diffraction/inference`}
                slice={`${displayFrameIdx},1`}
                pollIntervalMs={isFollowingLatest ? POLL_INTERVAL_MS : 0}
                cropBox={patchCropBox}
                centerAxes
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
        {sources.hasVitSegMask && (
          <button
            type="button"
            onClick={() => setShowMask((v) => !v)}
            aria-pressed={showMask}
            title={showMask ? 'Hide segmentation mask' : 'Show segmentation mask'}
            className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${
              showMask
                ? 'text-beam border-beam/40 hover:bg-beam/10'
                : 'text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border-medium'
            }`}
          >
            {showMask ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
            <span className="uppercase tracking-wider">Mask</span>
          </button>
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
