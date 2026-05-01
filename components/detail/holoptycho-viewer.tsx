'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Hash, Activity } from 'lucide-react';
import {
  fetchThumbnailIfChanged,
  listChildren,
  getMetadata,
} from '@/lib/tiled/client';
import { useTiledSubscription } from '@/hooks/use-tiled-subscription';

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
}

// Tiles poll on this cadence using If-None-Match. Most polls return 304 (cheap, ~1KB
// of headers) — only when the upstream array's bytes change does the full PNG transfer.
const POLL_INTERVAL_MS = 2000;

// Tiled's PNG endpoint silently ignores `cmap=` for our deployment — see
// array-viewer.tsx, which fetches grayscale and applies viridis client-side.
// We do the same here for magma so the ViT mosaic isn't rendered as B&W.
// LUT generated via matplotlib.cm.magma(np.linspace(0,1,256))[:, :3] * 255.
const MAGMA_LUT_FLAT = Uint8Array.of(
  0,0,4, 1,0,5, 1,1,6, 1,1,8, 2,1,9, 2,2,11, 2,2,13, 3,3,15, 3,3,18, 4,4,20, 5,4,22, 6,5,24, 6,5,26, 7,6,28, 8,7,30,
  9,7,32, 10,8,34, 11,9,36, 12,9,38, 13,10,41, 14,11,43, 16,11,45, 17,12,47, 18,13,49, 19,13,52, 20,14,54, 21,14,56,
  22,15,59, 24,15,61, 25,16,63, 26,16,66, 28,16,68, 29,17,71, 30,17,73, 32,17,75, 33,17,78, 34,17,80, 36,18,83,
  37,18,85, 39,18,88, 41,17,90, 42,17,92, 44,17,95, 45,17,97, 47,17,99, 49,17,101, 51,16,103, 52,16,105, 54,16,107,
  56,16,108, 57,15,110, 59,15,112, 61,15,113, 63,15,114, 64,15,116, 66,15,117, 68,15,118, 69,16,119, 71,16,120,
  73,16,120, 74,16,121, 76,17,122, 78,17,123, 79,18,123, 81,18,124, 82,19,124, 84,19,125, 86,20,125, 87,21,126,
  89,21,126, 90,22,126, 92,22,127, 93,23,127, 95,24,127, 96,24,128, 98,25,128, 100,26,128, 101,26,128, 103,27,128,
  104,28,129, 106,28,129, 107,29,129, 109,29,129, 110,30,129, 112,31,129, 114,31,129, 115,32,129, 117,33,129,
  118,33,129, 120,34,129, 121,34,130, 123,35,130, 124,35,130, 126,36,130, 128,37,130, 129,37,129, 131,38,129,
  132,38,129, 134,39,129, 136,39,129, 137,40,129, 139,41,129, 140,41,129, 142,42,129, 144,42,129, 145,43,129,
  147,43,128, 148,44,128, 150,44,128, 152,45,128, 153,45,128, 155,46,127, 156,46,127, 158,47,127, 160,47,127,
  161,48,126, 163,48,126, 165,49,126, 166,49,125, 168,50,125, 170,51,125, 171,51,124, 173,52,124, 174,52,123,
  176,53,123, 178,53,123, 179,54,122, 181,54,122, 183,55,121, 184,55,121, 186,56,120, 188,57,120, 189,57,119,
  191,58,119, 192,58,118, 194,59,117, 196,60,117, 197,60,116, 199,61,115, 200,62,115, 202,62,114, 204,63,113,
  205,64,113, 207,64,112, 208,65,111, 210,66,111, 211,67,110, 213,68,109, 214,69,108, 216,69,108, 217,70,107,
  219,71,106, 220,72,105, 222,73,104, 223,74,104, 224,76,103, 226,77,102, 227,78,101, 228,79,100, 229,80,100,
  231,82,99, 232,83,98, 233,84,98, 234,86,97, 235,87,96, 236,88,96, 237,90,95, 238,91,94, 239,93,94, 240,95,94,
  241,96,93, 242,98,93, 242,100,92, 243,101,92, 244,103,92, 244,105,92, 245,107,92, 246,108,92, 246,110,92,
  247,112,92, 247,114,92, 248,116,92, 248,118,92, 249,120,93, 249,121,93, 249,123,93, 250,125,94, 250,127,94,
  250,129,95, 251,131,95, 251,133,96, 251,135,97, 252,137,97, 252,138,98, 252,140,99, 252,142,100, 252,144,101,
  253,146,102, 253,148,103, 253,150,104, 253,152,105, 253,154,106, 253,155,107, 254,157,108, 254,159,109, 254,161,110,
  254,163,111, 254,165,113, 254,167,114, 254,169,115, 254,170,116, 254,172,118, 254,174,119, 254,176,120, 254,178,122,
  254,180,123, 254,182,124, 254,183,126, 254,185,127, 254,187,129, 254,189,130, 254,191,132, 254,193,133, 254,194,135,
  254,196,136, 254,198,138, 254,200,140, 254,202,141, 254,204,143, 254,205,144, 254,207,146, 254,209,148, 254,211,149,
  254,213,151, 254,215,153, 254,216,154, 253,218,156, 253,220,158, 253,222,160, 253,224,161, 253,226,163, 253,227,165,
  253,229,167, 253,231,169, 253,233,170, 253,235,172, 252,236,174, 252,238,176, 252,240,178, 252,242,180, 252,244,182,
  252,246,184, 252,247,185, 252,249,187, 252,251,189, 252,253,191
);

async function applyMagmaToImage(blobUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Could not get canvas context')); return; }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const gray = data[i];
        const j = gray * 3;
        data[i]     = MAGMA_LUT_FLAT[j];
        data[i + 1] = MAGMA_LUT_FLAT[j + 1];
        data[i + 2] = MAGMA_LUT_FLAT[j + 2];
      }
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolve(URL.createObjectURL(blob));
        else reject(new Error('Failed to create blob'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = blobUrl;
  });
}

async function discoverSources(runPath: string): Promise<SourceInfo> {
  try {
    const children = await listChildren(runPath, { limit: 10 });
    const ids = new Set(children.items.map(c => c.id));
    const iterativeSource = ids.has('live') ? 'live' : ids.has('final') ? 'final' : null;
    return { iterativeSource, hasVit: ids.has('vit') };
  } catch {
    return { iterativeSource: null, hasVit: false };
  }
}

interface TiledImageTileProps {
  title: string;
  subtitle?: string;
  path: string;
  // Slice expression passed to tiled — e.g. 0 for (mode, H, W) or "0,1" for (B, C, H, W)
  slice: number | string;
  cmap?: string;
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
  cmap = 'viridis',
  pollIntervalMs,
  onChanged,
}: TiledImageTileProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousUrlRef = useRef<string | null>(null);
  const onChangedRef = useRef(onChanged);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    let cancelled = false;
    let etag: string | null = null;
    let inflight = false;

    const tick = async () => {
      if (cancelled || inflight) return;
      inflight = true;
      const result = await fetchThumbnailIfChanged(path, cmap, slice, etag);
      inflight = false;
      if (cancelled) {
        if (result.status === 'changed') URL.revokeObjectURL(result.blobUrl);
        return;
      }
      if (result.status === 'changed') {
        etag = result.etag;
        // Tiled returns a grayscale PNG — apply the requested colormap
        // client-side. The returned blob from fetchThumbnailIfChanged is
        // revoked once we've consumed it via the colormap canvas pass.
        let displayUrl = result.blobUrl;
        if (cmap === 'magma') {
          try {
            displayUrl = await applyMagmaToImage(result.blobUrl);
          } catch {
            // Fall back to the grayscale PNG if the canvas pass fails.
          } finally {
            if (displayUrl !== result.blobUrl) URL.revokeObjectURL(result.blobUrl);
          }
          if (cancelled) { URL.revokeObjectURL(displayUrl); return; }
        }
        if (previousUrlRef.current) URL.revokeObjectURL(previousUrlRef.current);
        previousUrlRef.current = displayUrl;
        setImageUrl(displayUrl);
        setHasLoadedOnce(true);
        setError(null);
        onChangedRef.current?.();
      } else if (result.status === 'error' && !etag) {
        // Only surface errors before we've ever loaded; transient errors during polling
        // shouldn't replace a perfectly good last frame.
        setError('Failed to load');
        setHasLoadedOnce(true);
      }
    };

    tick();
    if (!pollIntervalMs) {
      return () => { cancelled = true; };
    }
    const handle = setInterval(tick, pollIntervalMs);
    return () => { cancelled = true; clearInterval(handle); };
  }, [path, slice, cmap, pollIntervalMs]);

  // Revoke on unmount
  useEffect(() => {
    return () => {
      if (previousUrlRef.current) URL.revokeObjectURL(previousUrlRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-medium">{title}</span>
        {subtitle && <span className="text-[10px] text-text-tertiary font-mono">{subtitle}</span>}
      </div>
      <div className="relative aspect-square rounded-lg overflow-hidden bg-surface-raised border border-border-subtle">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={title} className="w-full h-full object-contain" />
        ) : null}
        {!hasLoadedOnce && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-beam animate-spin" />
          </div>
        )}
        {error && !imageUrl && (
          <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-xs">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export function HoloptychoViewer({ path, metadata }: HoloptychoViewerProps) {
  const [sources, setSources] = useState<SourceInfo>({ iterativeSource: null, hasVit: false });
  const [isDiscovering, setIsDiscovering] = useState(true);
  const [iteration, setIteration] = useState<number | null>(null);
  // Wall-clock time of the most recent refresh — drives the "updated Xs ago" indicator.
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  // Forces the relative-time string to recompute every second so the indicator ticks up.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setNowTick(t => t + 1), 1000);
    return () => clearInterval(handle);
  }, []);

  const containerMeta = metadata as { scan_id?: number | string; recon_mode?: string; run_uid?: string } | undefined;

  // Initial discovery: figure out which sub-containers exist on this run.
  useEffect(() => {
    let cancelled = false;
    setIsDiscovering(true);
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
  }, []);

  if (isDiscovering) {
    return (
      <div className="flex items-center justify-center h-64 rounded-xl bg-surface-raised border border-border-subtle">
        <Loader2 className="w-5 h-5 text-beam animate-spin" />
      </div>
    );
  }

  if (!sources.iterativeSource && !sources.hasVit) {
    return (
      <div className="flex items-center justify-center h-32 rounded-xl bg-surface-raised border border-border-subtle">
        <span className="text-sm text-text-tertiary">Run has no live/, final/, or vit/ data yet</span>
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
          <TiledImageTile
            title={`${sources.iterativeSource === 'live' ? 'Iterative' : 'Final'} object |·|`}
            subtitle={iteration !== null ? `iter ${iteration}` : undefined}
            path={objectPath}
            slice={0}
            pollIntervalMs={iterativePollMs}
            onChanged={handleObjectChanged}
          />
        )}
        {sources.hasVit && (
          <TiledImageTile
            title="ViT mosaic (phase)"
            path={`${path}/vit/mosaic`}
            slice=":,:"
            cmap="magma"
            pollIntervalMs={vitPollMs}
            onChanged={handleVitChanged}
          />
        )}
        {probePath && (
          <TiledImageTile
            title="Probe |·|"
            path={probePath}
            slice={0}
            pollIntervalMs={iterativePollMs}
            onChanged={handleProbeChanged}
          />
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
