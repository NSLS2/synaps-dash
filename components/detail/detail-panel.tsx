'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronDown, Copy, Check, Layers, Grid3X3, Clock, Hash, Maximize2, Activity } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ArrayViewer } from './array-viewer';
import { HoloptychoViewer } from './holoptycho-viewer';
import { NiiVueViewer } from './niivue-viewer';
import { SvgExportButton } from './svg-export-button';
import { SegmentationPlotButton } from './segmentation-plot';
import { DatasetItem } from '@/lib/tiled/types';
import { listChildren, fetchTableData, findReconstructionByScanId, getMetadata } from '@/lib/tiled/client';

function isHoloptychoRun(path: string, structureFamily: string): boolean {
  if (structureFamily !== 'container') return false;
  const idx = path.indexOf('hxn/processed/holoptycho/');
  if (idx === -1) return false;
  const tail = path.slice(idx + 'hxn/processed/holoptycho/'.length);
  return tail.length > 0 && !tail.includes('/');
}

interface DetailPanelProps {
  item: DatasetItem | null;
  onClose: () => void;
}

// Drawer is user-resizable; width persists across sessions in localStorage.
const DRAWER_MIN_WIDTH = 420;
const DRAWER_DEFAULT_WIDTH = 576; // matches the previous fixed max-w-xl
const DRAWER_VIEWPORT_PAD = 64;   // keep a sliver of the list visible at max width
const DRAWER_WIDTH_KEY = 'detailPanelWidth';

function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
  icon: Icon,
  copyValue,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  icon?: React.ElementType;
  copyValue?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!copyValue) return;
    await navigator.clipboard.writeText(copyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      className="rounded-lg overflow-hidden bg-surface-raised/50 border border-border-subtle"
      initial={false}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-4 py-3 text-sm hover:bg-surface-overlay/50 transition-colors group"
      >
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-3.5 h-3.5 text-text-tertiary group-hover:text-beam transition-colors" />}
          <span className="font-medium text-text-secondary group-hover:text-text-primary transition-colors">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {copyValue && (
            <div
              role="button"
              onClick={handleCopy}
              className="p-1.5 text-text-tertiary hover:text-beam hover:bg-beam/10 rounded-md transition-all"
            >
              {copied ? <Check className="h-3 w-3 text-live" /> : <Copy className="h-3 w-3" />}
            </div>
          )}
          <motion.div
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="h-4 w-4 text-text-tertiary" />
          </motion.div>
        </div>
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 overflow-hidden">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1.5 text-text-tertiary hover:text-beam transition-all rounded-md hover:bg-beam/10"
    >
      {copied ? <Check className="h-3 w-3 text-live" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function MetadataItem({
  label,
  value,
  copyable = false,
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  copyable?: boolean;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex items-center justify-between py-2 group">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="w-3 h-3 text-text-tertiary" />}
        <span className="text-[11px] uppercase tracking-wider text-text-tertiary font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-1">
        <span className="font-mono text-xs text-text-primary">
          {value}
        </span>
        {copyable && typeof value === 'string' && <CopyButton value={value} />}
      </div>
    </div>
  );
}

function ElementBadge({ element }: { element: string }) {
  const colors: Record<string, string> = {
    Fe: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    Cu: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    Ni: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    Zn: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    Ca: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
    K: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    S: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
    P: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  };

  const colorClass = colors[element] || 'bg-slate-500/15 text-slate-400 border-slate-500/30';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-mono font-semibold border ${colorClass}`}>
      {element}
    </span>
  );
}

export function DetailPanel({ item, onClose }: DetailPanelProps) {
  const [arrayPath, setArrayPath] = useState<string | null>(null);
  const [arrayShape, setArrayShape] = useState<number[] | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [segmentationTableData, setSegmentationTableData] = useState<Record<string, unknown>[] | null>(null);
  const [reconstructionMetadata, setReconstructionMetadata] = useState<Record<string, unknown> | null>(null);
  const [arrayChildren, setArrayChildren] = useState<DatasetItem[]>([]);
  // Initialize from the persisted width (clamped to the viewport). The panel
  // only renders when an item is selected (client-side), so reading storage in
  // the initializer is safe — guarded for SSR where window is undefined.
  const [drawerWidth, setDrawerWidth] = useState(() => {
    if (typeof window === 'undefined') return DRAWER_DEFAULT_WIDTH;
    const saved = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) {
      const max = window.innerWidth - DRAWER_VIEWPORT_PAD;
      return Math.max(DRAWER_MIN_WIDTH, Math.min(saved, max));
    }
    return DRAWER_DEFAULT_WIDTH;
  });
  const resizingRef = useRef(false);

  // Persist drawer width whenever it changes.
  useEffect(() => {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth));
  }, [drawerWidth]);

  // Drag the left edge to resize. The drawer is anchored to the right, so its
  // width grows as the pointer moves left: width = viewport width - pointer X.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      const max = window.innerWidth - DRAWER_VIEWPORT_PAD;
      setDrawerWidth(Math.max(DRAWER_MIN_WIDTH, Math.min(window.innerWidth - ev.clientX, max)));
    };
    const onUp = () => {
      resizingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const isHoloptycho = item ? isHoloptychoRun(item.path, item.structureFamily) : false;

  useEffect(() => {
    if (!item) return;

    // Reset segmentation data when item changes
    setSegmentationTableData(null);
    setArrayChildren([]);

    // Holoptycho runs are rendered by their own viewer — no array discovery needed.
    if (isHoloptychoRun(item.path, item.structureFamily)) {
      setArrayPath(null);
      setArrayShape(null);
      setReconstructionMetadata(null);
      setIsDiscovering(false);
      return;
    }

    if (item.structureFamily === 'array') {
      setArrayPath(item.path);
      setArrayShape(item.shape || null);
      return;
    }

    // Handle segmentation containers - find reconstruction and fetch table data
    if (item.structureFamily === 'container' && item.path.includes('synaps/segmentations')) {
      setIsDiscovering(true);
      setArrayPath(null);
      setArrayShape(null);
      setReconstructionMetadata(null);

      const scanIdMatch = item.id.match(/automap_(\d+)_/);

      if (scanIdMatch) {
        Promise.all([
          findReconstructionByScanId(item.path, scanIdMatch[1]),
          // Also fetch the first table child's data
          listChildren(item.path, { limit: 10 }).then(async (children) => {
            const firstTable = children.items.find(c => c.structureFamily === 'table');
            if (firstTable) {
              return fetchTableData(firstTable.path);
            }
            return null;
          })
        ]).then(async ([reconstructionArrayPath, tableData]) => {
          if (reconstructionArrayPath) {
            setArrayPath(reconstructionArrayPath);
            // Fetch metadata from the reconstruction container (parent of the array)
            const containerPath = reconstructionArrayPath.split('/').slice(0, -1).join('/');
            try {
              const reconMeta = await getMetadata(containerPath);
              setReconstructionMetadata(reconMeta);
            } catch (e) {
              console.warn('Failed to fetch reconstruction metadata:', e);
            }
          }
          if (tableData) {
            setSegmentationTableData(tableData);
          }
        }).catch(err => {
          console.error('[DetailPanel] Error fetching segmentation data:', err);
        }).finally(() => setIsDiscovering(false));
      } else {
        setIsDiscovering(false);
      }
      return;
    }

    if (item.structureFamily === 'container' && item.path.includes('synaps/reconstructions')) {
      setIsDiscovering(true);
      listChildren(item.path, { limit: 10 })
        .then((result) => {
          const firstArray = result.items.find(child => child.structureFamily === 'array');
          if (firstArray) {
            setArrayPath(firstArray.path);
            setArrayShape(firstArray.shape || null);
          }
        })
        .finally(() => setIsDiscovering(false));
      return;
    }

    // Handle BlueskyRun items - discover array in primary/data/{detector}
    if (item.specs?.includes('BlueskyRun')) {
      setIsDiscovering(true);
      setArrayPath(null);
      setArrayShape(null);

      const primaryDataPath = `${item.path}/primary/data`;
      listChildren(primaryDataPath, { limit: 20, sort: '' })
        .then((result) => {
          // BlueskyRun detector data (like eiger2_image) is often stored externally
          // and may not be directly accessible via tiled's array endpoint.
          // For now, we skip showing the image to avoid 500 errors.
          // The arrays are discovered but we don't set arrayPath.
        })
        .catch(err => {
          console.warn('[DetailPanel] BlueskyRun discovery failed:', err);
        })
        .finally(() => setIsDiscovering(false));
      return;
    }

    // Generic container fallback: find array children and let the user pick one.
    // Covers hxn/processed/segmentations/{run} (4 sibling 3D volumes) and similar.
    if (item.structureFamily === 'container') {
      setIsDiscovering(true);
      setArrayPath(null);
      setArrayShape(null);
      listChildren(item.path, { limit: 20 })
        .then((result) => {
          const arrays = result.items.filter(c => c.structureFamily === 'array');
          setArrayChildren(arrays);
          if (arrays.length > 0) {
            setArrayPath(arrays[0].path);
            setArrayShape(arrays[0].shape || null);
          }
        })
        .catch(err => {
          console.warn('[DetailPanel] Container discovery failed:', err);
        })
        .finally(() => setIsDiscovering(false));
      return;
    }

    setArrayPath(null);
    setArrayShape(null);
  }, [item]);

  if (!item) return null;

  const metadata = item.metadata as {
    scan_id?: number;
    uid?: string;
    element_list?: string[];
    step_size?: number;
    sample?: string;
    project?: string;
    roi_positions?: Record<string, number>;
    export_timestamp?: number;
    start_doc?: Record<string, unknown>;
    precomputed_blobs?: Record<string, unknown>;
    groups?: Record<string, unknown>;
    blob_detection_method?: string;
  };

  const hasViewableArray = arrayPath !== null;
  // Compute numSlices based on array dimensionality
  // 3D [N, H, W]: numSlices = N (first dimension)
  // 4D [1, N, H, W]: numSlices = N (second dimension, first is usually batch=1)
  let numSlices: number | undefined;
  if (arrayShape) {
    if (arrayShape.length === 3) {
      numSlices = arrayShape[0];
    } else if (arrayShape.length === 4) {
      numSlices = arrayShape[1]; // Second dimension for 4D arrays
    }
  }

  return (
    <motion.div
        initial={{ x: '100%', opacity: 0.8 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: '100%', opacity: 0.8 }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        className="fixed right-0 top-0 h-full max-w-[100vw] z-50 flex flex-col"
        style={{ width: drawerWidth }}
      >
        {/* Resize handle — drag the left edge to widen/narrow the drawer.
            Images are aspect-square in a 2-col grid, so they scale with width. */}
        <div
          onPointerDown={startResize}
          title="Drag to resize"
          className="absolute left-0 top-0 h-full w-2 cursor-col-resize z-20 group flex items-center justify-center"
        >
          <div className="h-full w-px bg-border-medium group-hover:bg-beam/60 transition-colors" />
        </div>

        {/* Glass panel container */}
        <div className="h-full m-3 ml-0 rounded-2xl overflow-hidden glass border border-border-medium flex flex-col">

          {/* Header */}
          <div className="flex-shrink-0 px-5 py-4 border-b border-border-subtle bg-surface-base/50">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {/* Scan ID / Title */}
                <div className="flex items-center gap-3 mb-1">
                  {metadata.scan_id ? (
                    <span className="text-2xl font-semibold text-beam tracking-tight">
                      #{metadata.scan_id}
                    </span>
                  ) : (
                    <span className="text-lg font-semibold text-text-primary tracking-tight">
                      {item.id.length > 20 ? item.id.slice(0, 8) + '...' : item.id}
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded-md bg-surface-overlay text-[10px] font-mono text-text-tertiary uppercase tracking-wider">
                    {item.structureFamily}
                  </span>
                </div>

                {/* Path */}
                <p className="text-xs text-text-tertiary font-mono truncate opacity-60">
                  {item.path}
                </p>
              </div>

              {/* Close button */}
              <button
                onClick={onClose}
                className="p-2 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-surface-overlay transition-all"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <ScrollArea className="flex-1 overflow-hidden">
            <div className="p-5 space-y-5 min-w-0 max-w-full">

              {/* Holoptycho run viewer */}
              {isHoloptycho && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                >
                  <HoloptychoViewer path={item.path} metadata={item.metadata} />
                </motion.div>
              )}

              {/* Image Viewer */}
              {!isHoloptycho && (hasViewableArray || isDiscovering) && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}
                >
                  {isDiscovering ? (
                    <div className="flex items-center justify-center h-64 rounded-xl bg-surface-raised border border-border-subtle">
                      <div className="flex items-center gap-3 text-text-tertiary">
                        <div className="w-4 h-4 border-2 border-beam border-t-transparent rounded-full animate-spin" />
                        <span className="text-sm">Loading image...</span>
                      </div>
                    </div>
                  ) : arrayPath ? (
                    <div className="space-y-3">
                      {arrayChildren.length > 1 && (
                        <div className="flex flex-wrap gap-1.5">
                          {arrayChildren.map((child) => {
                            const isActive = child.path === arrayPath;
                            return (
                              <button
                                key={child.path}
                                onClick={() => {
                                  setArrayPath(child.path);
                                  setArrayShape(child.shape || null);
                                }}
                                className={`px-2.5 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                                  isActive
                                    ? 'bg-beam/15 text-beam border-beam/40'
                                    : 'bg-surface-raised/50 text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border-medium'
                                }`}
                              >
                                {child.id}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {arrayChildren.length > 0 && arrayShape?.length === 3 ? (
                        <NiiVueViewer key={arrayPath} path={arrayPath} />
                      ) : (
                        <>
                          <ArrayViewer
                            path={arrayPath}
                            metadata={reconstructionMetadata || metadata}
                            showScalebar={false}
                            showColorbar={false}
                            numSlices={numSlices}
                            arrayShape={arrayShape || undefined}
                            segmentationRows={segmentationTableData}
                          />
                          <div className="flex gap-2">
                            <SvgExportButton path={arrayPath} filename={`${metadata.scan_id || item.id}.svg`} />
                            <SegmentationPlotButton
                              path={arrayPath}
                              metadata={metadata}
                              title={`Segmentation - Scan ${metadata.scan_id || item.id}`}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </motion.div>
              )}

              {/* Quick Stats */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="grid grid-cols-3 gap-3"
              >
                {metadata.scan_id && (
                  <div className="p-3 rounded-lg bg-surface-raised/50 border border-border-subtle">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Hash className="w-3 h-3 text-beam" />
                      <span className="text-[10px] uppercase tracking-wider text-text-tertiary">Scan</span>
                    </div>
                    <span className="text-lg font-semibold text-text-primary font-mono">{metadata.scan_id}</span>
                  </div>
                )}
                {item.shape && (
                  <div className="p-3 rounded-lg bg-surface-raised/50 border border-border-subtle">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Grid3X3 className="w-3 h-3 text-cell" />
                      <span className="text-[10px] uppercase tracking-wider text-text-tertiary">Size</span>
                    </div>
                    <span className="text-lg font-semibold text-text-primary font-mono">{item.shape.join('×')}</span>
                  </div>
                )}
                {item.timeCreated && (
                  <div className="p-3 rounded-lg bg-surface-raised/50 border border-border-subtle">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Clock className="w-3 h-3 text-data" />
                      <span className="text-[10px] uppercase tracking-wider text-text-tertiary">Created</span>
                    </div>
                    <span className="text-sm font-medium text-text-primary">
                      {new Date(item.timeCreated).toLocaleDateString()}
                    </span>
                  </div>
                )}
              </motion.div>

              {/* Elements */}
              {metadata.element_list && metadata.element_list.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  className="space-y-3"
                >
                  <h3 className="text-[11px] uppercase tracking-wider text-text-tertiary font-medium">Elements</h3>
                  <div className="flex flex-wrap gap-2">
                    {metadata.element_list.map((element) => (
                      <ElementBadge key={element} element={element} />
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Segmentation Info */}
              {item.path.includes('synaps/segmentations') && segmentationTableData && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.22 }}
                >
                  <CollapsibleSection title="Segmentation Info" defaultOpen={true} icon={Activity}>
                    <div className="divide-y divide-border-subtle">
                      <MetadataItem label="Cells Detected" value={segmentationTableData.length} />
                      {metadata.blob_detection_method && (
                        <MetadataItem label="Detection Method" value={metadata.blob_detection_method as string} />
                      )}
                      {metadata.step_size && (
                        <MetadataItem label="Step Size" value={`${metadata.step_size} µm`} />
                      )}
                    </div>
                  </CollapsibleSection>
                </motion.div>
              )}

              {/* Metadata Section */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
              >
                <CollapsibleSection
                  title="Metadata"
                  defaultOpen={true}
                  icon={Layers}
                  copyValue={JSON.stringify({ uid: metadata.uid, sample: metadata.sample, project: metadata.project, step_size: metadata.step_size, timeCreated: item.timeCreated }, null, 2)}
                >
                  <div className="divide-y divide-border-subtle">
                    {metadata.uid && (
                      <MetadataItem label="UID" value={`${metadata.uid.slice(0, 8)}...`} copyable />
                    )}
                    {metadata.sample && (
                      <MetadataItem label="Sample" value={metadata.sample} copyable />
                    )}
                    {metadata.project && (
                      <MetadataItem label="Project" value={metadata.project} />
                    )}
                    {metadata.step_size && (
                      <MetadataItem label="Step Size" value={`${metadata.step_size} µm`} />
                    )}
                    {item.timeCreated && (
                      <MetadataItem label="Created" value={new Date(item.timeCreated).toLocaleString()} icon={Clock} />
                    )}
                  </div>
                </CollapsibleSection>
              </motion.div>

              {/* ROI Positions */}
              {metadata.roi_positions && Object.keys(metadata.roi_positions).length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                >
                  <CollapsibleSection title="ROI Positions" icon={Maximize2} copyValue={JSON.stringify(metadata.roi_positions, null, 2)}>
                    <div className="divide-y divide-border-subtle">
                      {Object.entries(metadata.roi_positions).map(([key, value]) => (
                        <MetadataItem
                          key={key}
                          label={key}
                          value={typeof value === 'number' ? value.toFixed(4) : String(value)}
                        />
                      ))}
                    </div>
                  </CollapsibleSection>
                </motion.div>
              )}

              {/* Raw Metadata */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 }}
              >
                <CollapsibleSection title="Raw Data" copyValue={JSON.stringify(item.metadata, null, 2)}>
                  <div className="w-0 min-w-full">
                    <pre className="bg-void/50 rounded-lg p-3 text-[11px] text-text-secondary overflow-auto font-mono border border-border-subtle max-h-64">
                      {JSON.stringify(item.metadata, null, 2)}
                    </pre>
                  </div>
                </CollapsibleSection>
              </motion.div>

            </div>
          </ScrollArea>
        </div>
      </motion.div>
  );
}
