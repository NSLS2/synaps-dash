import { TiledSearchResponse, TiledNode, DatasetItem } from './types';
import { getAuthHeader, getValidAccessToken, getAuthType, clearTokens } from './auth';

// Use local API proxy to avoid CORS issues
const API_BASE = '/api/tiled';

// Request deduplication cache - prevents duplicate concurrent requests
const pendingRequests = new Map<string, Promise<Response>>();
const CACHE_TTL = 30000; // Cache results for 30 seconds to reduce API load
const responseCache = new Map<string, { data: unknown; timestamp: number }>();

// Reconstruction cache: maps scan_id -> reconstruction item (persists across session)
const reconstructionByScanId = new Map<string, DatasetItem>();

// Helper to extract scan_id from item ID (e.g., "automap_394157_xxx" -> "394157")
function extractScanIdFromId(id: string): string | null {
  const match = id.match(/automap_(\d+)_/);
  return match ? match[1] : null;
}

function getCachedResponse<T>(key: string): T | null {
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data as T;
  }
  return null;
}

function setCachedResponse(key: string, data: unknown): void {
  responseCache.set(key, { data, timestamp: Date.now() });
  // Clean old entries periodically
  if (responseCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.timestamp > CACHE_TTL) {
        responseCache.delete(k);
      }
    }
  }
}

// Keep original URL for reference/WebSocket
const TILED_URL = process.env.NEXT_PUBLIC_TILED_URL || 'https://tiled.nsls2.bnl.gov';

// Event emitter for auth errors - allows components to react to 401s
type AuthErrorListener = () => void;
const authErrorListeners: Set<AuthErrorListener> = new Set();

export function onAuthError(listener: AuthErrorListener): () => void {
  authErrorListeners.add(listener);
  return () => authErrorListeners.delete(listener);
}

function notifyAuthError(): void {
  authErrorListeners.forEach(listener => listener());
}

// Get a valid auth header, refreshing token if needed
async function getValidAuthHeader(): Promise<string | null> {
  // For Entra sessions, auth is handled server-side via cookies
  // The browser automatically sends cookies; no Authorization header needed
  const authType = getAuthType();
  if (authType === 'entra') {
    return null;
  }

  const token = await getValidAccessToken();
  if (!token) {
    console.log('[Client] No valid token available');
    return null;
  }

  return authType === 'apikey' ? `Apikey ${token}` : `Bearer ${token}`;
}

async function fetchWithAuth(url: string, options: RequestInit = {}, isRetry = false): Promise<Response> {
  const authHeader = await getValidAuthHeader();

  const headers = new Headers(options.headers);
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }

  const response = await fetch(url, { ...options, headers });

  // On 401, try to refresh and retry once
  if (response.status === 401 && !isRetry) {
    const currentAuthType = getAuthType();

    if (currentAuthType === 'entra') {
      // For Entra sessions, call the server-side refresh endpoint
      console.log('[Client] Got 401 in Entra mode, calling server refresh...');
      try {
        const refreshResponse = await fetch('/api/auth/entra/refresh', { method: 'POST' });
        if (refreshResponse.ok) {
          console.log('[Client] Entra session refreshed, retrying request...');
          return fetchWithAuth(url, options, true);
        }
      } catch {
        // Refresh failed
      }
      // Refresh failed - notify auth error
      console.log('[Client] Entra refresh failed, logging out');
      const { clearEntraAuthMarker } = await import('./auth');
      clearEntraAuthMarker();
      notifyAuthError();
    } else {
      // For Tiled token auth, try client-side refresh
      console.log('[Client] Got 401, attempting token refresh and retry...');
      const { refreshAccessToken } = await import('./auth');
      const refreshed = await refreshAccessToken();

      if (refreshed) {
        console.log('[Client] Token refreshed, retrying request...');
        return fetchWithAuth(url, options, true);
      }

      // Refresh failed - clear tokens and notify
      console.log('[Client] Token refresh failed, logging out');
      clearTokens();
      notifyAuthError();
    }
  }

  return response;
}

export interface ListChildrenOptions {
  offset?: number;
  limit?: number;
  sort?: string;
  fullText?: string;
  filters?: Record<string, string>;
}

// Parse search query for field-specific filters
// Supports: "scan_id:12345", "element:Fe", or just "12345" (treated as scan_id)
function parseSearchQuery(query: string): { fullText?: string; fieldFilters: Record<string, string> } {
  const trimmed = query.trim();
  if (!trimmed) return { fieldFilters: {} };

  const fieldFilters: Record<string, string> = {};

  // Check for field:value patterns
  const fieldPattern = /^(\w+):(.+)$/;
  const match = trimmed.match(fieldPattern);

  if (match) {
    const [, field, value] = match;
    fieldFilters[field] = value.trim();
    return { fieldFilters };
  }

  // If it's just a number, treat as scan_id search
  if (/^\d+$/.test(trimmed)) {
    fieldFilters['scan_id'] = trimmed;
    return { fieldFilters };
  }

  // Otherwise, use fulltext search
  return { fullText: trimmed, fieldFilters: {} };
}

export async function listChildren(
  path: string,
  options: ListChildrenOptions = {}
): Promise<{ items: DatasetItem[]; hasMore: boolean; totalCount: number }> {
  // Determine appropriate sort based on path
  // - "raw" collections (databroker) use scan_id (top-level)
  // - synaps reconstructions use metadata.scan_id (tiled-native)
  // - synaps segmentations have empty metadata, sort by id (contains scan_id)
  // - Other collections use "_" for default ordering
  const getDefaultSort = (p: string): string => {
    if (p.includes('/raw')) return '-scan_id';
    if (p.includes('/reconstructions')) return '-metadata.scan_id';
    if (p.includes('/segmentations')) return '-id';
    if (p.endsWith('/holoptycho')) return '-metadata.started_at';
    return '-_';
  };
  const { offset = 0, limit = 20, sort = getDefaultSort(path), fullText, filters } = options;

  const url = new URL(`${API_BASE}/search/${path}`, window.location.origin);
  url.searchParams.set('page[offset]', offset.toString());
  url.searchParams.set('page[limit]', limit.toString());
  if (sort) {
    url.searchParams.set('sort', sort);
  }

  // Parse and apply search query
  if (fullText && fullText.trim()) {
    const parsed = parseSearchQuery(fullText);

    // Apply fulltext search if present
    if (parsed.fullText) {
      url.searchParams.set('filter[fulltext][condition][text]', parsed.fullText);
    }

    // Apply field-specific Eq filters
    for (const [field, value] of Object.entries(parsed.fieldFilters)) {
      url.searchParams.set('filter[eq][condition][key]', field);
      url.searchParams.set('filter[eq][condition][value]', value);
    }
  }

  // Add additional filters if provided
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      url.searchParams.set(key, value);
    }
  }

  const cacheKey = url.toString();

  // Check cache first
  const cached = getCachedResponse<{ items: DatasetItem[]; hasMore: boolean; totalCount: number }>(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetchWithAuth(cacheKey);

  if (!response.ok) {
    throw new Error(`Failed to list children: ${response.status} ${response.statusText}`);
  }

  const data: TiledSearchResponse<TiledNode> = await response.json();

  let items: DatasetItem[] = data.data.map((node) => ({
    id: node.id,
    path: `${path}/${node.id}`,
    metadata: node.attributes.metadata,
    structureFamily: node.attributes.structure_family,
    specs: node.attributes.specs?.map((s) => s.name) || [],
    shape: node.attributes.structure?.shape,
    timeCreated: findTimestamp(node.attributes.metadata),
  }));

  // Filter out non-automap items from top-level synaps reconstructions/segmentations only
  if (path.endsWith('synaps/reconstructions') || path.endsWith('synaps/segmentations')) {
    items = items.filter(item => item.id.startsWith('automap_'));
  }

  function findTimestamp(metadata: Record<string, unknown>): string | undefined {
    if (!metadata) return undefined;

    // Common timestamp field names
    const timestampKeys = [
      'time_created',
      'time',
      'timestamp',
      'created_at',
      'creation_time',
      'date',
      'datetime',
    ];

    for (const key of timestampKeys) {
      if (metadata[key] !== undefined) {
        const value = metadata[key];
        // Handle both string timestamps and unix timestamps
        if (typeof value === 'string') return value;
        if (typeof value === 'number') {
          // Unix timestamp (seconds) - convert to ISO string
          return new Date(value * 1000).toISOString();
        }
      }
    }

    // Check nested in start document
    if (metadata.start && typeof metadata.start === 'object') {
      const start = metadata.start as Record<string, unknown>;
      if (start.time !== undefined) {
        const value = start.time;
        if (typeof value === 'string') return value;
        if (typeof value === 'number') return new Date(value * 1000).toISOString();
      }
    }

    // Check export_timestamp
    if (metadata.export_timestamp !== undefined) {
      const value = metadata.export_timestamp;
      if (typeof value === 'number') return new Date(value * 1000).toISOString();
    }

    return undefined;
  }

  const result = {
    items,
    hasMore: data.links.next !== null,
    totalCount: data.meta.count,
  };

  // Cache the result
  setCachedResponse(cacheKey, result);

  // Populate reconstruction cache when loading reconstructions
  if (path.includes('/reconstructions') && !path.includes('/reconstructions/')) {
    for (const item of items) {
      const scanId = extractScanIdFromId(item.id);
      if (scanId && !reconstructionByScanId.has(scanId)) {
        reconstructionByScanId.set(scanId, item);
      }
    }
  }

  return result;
}

export async function getMetadata(path: string): Promise<Record<string, unknown>> {
  const url = `${API_BASE}/metadata/${path}`;
  const response = await fetchWithAuth(url);

  if (!response.ok) {
    throw new Error(`Failed to get metadata: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  // Handle different response structures
  if (data?.attributes?.metadata) {
    return data.attributes.metadata;
  }
  if (data?.data?.attributes?.metadata) {
    return data.data.attributes.metadata;
  }
  // Return the data itself if it looks like metadata
  if (data && typeof data === 'object') {
    return data;
  }
  throw new Error('Unexpected metadata response structure');
}

export function getThumbnailUrl(path: string, cmap: string = 'viridis', slice: number | string = 0): string {
  // Build URL with slice parameter
  // Note: slice can contain commas and colons which are valid in query params without encoding
  return `${API_BASE}/array/full/${path}?format=image/png&cmap=${cmap}&slice=${slice}`;
}

export function getPngUrl(path: string, cmap: string = 'viridis'): string {
  return `${API_BASE}/array/full/${path}?format=image/png&cmap=${cmap}`;
}

export function getArrayFullUrl(path: string, format: string = 'image/png', cmap: string = 'viridis'): string {
  return `${API_BASE}/array/full/${path}?format=${encodeURIComponent(format)}&cmap=${cmap}`;
}

export async function fetchThumbnail(
  path: string,
  cmap: string = 'viridis',
  slice: number | string = 0,
): Promise<string | null> {
  try {
    const authHeader = await getValidAuthHeader();
    const url = getThumbnailUrl(path, cmap, slice);

    const response = await fetch(url, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });

    if (!response.ok) return null;

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export type EtagFetchResult =
  | { status: 'changed'; etag: string | null; blobUrl: string }
  | { status: 'unchanged'; etag: string | null }
  | { status: 'error' };

// Fetch a thumbnail using If-None-Match for change detection. When the upstream ETag
// matches `lastEtag`, the proxy returns 304 and we skip allocating a new blob URL.
// Used by long-running views that need to detect in-place data overwrites cheaply.
export async function fetchThumbnailIfChanged(
  path: string,
  cmap: string,
  slice: number | string,
  lastEtag: string | null,
): Promise<EtagFetchResult> {
  try {
    const authHeader = await getValidAuthHeader();
    const url = getThumbnailUrl(path, cmap, slice);

    const headers: Record<string, string> = {};
    if (authHeader) headers['Authorization'] = authHeader;
    if (lastEtag) headers['If-None-Match'] = lastEtag;

    const response = await fetch(url, { headers });

    if (response.status === 304) {
      return { status: 'unchanged', etag: lastEtag };
    }
    if (!response.ok) {
      return { status: 'error' };
    }

    const etag = response.headers.get('ETag');
    const blob = await response.blob();
    return { status: 'changed', etag, blobUrl: URL.createObjectURL(blob) };
  } catch {
    return { status: 'error' };
  }
}

// Fetch thumbnail with downsampling for large detector images
// Uses strided slicing (e.g., ::8,::8 takes every 8th pixel)
export async function fetchDownsampledThumbnail(
  path: string,
  downsampleFactor: number = 8,
  cmap: string = 'viridis',
  arrayDims: number = 3
): Promise<string | null> {
  // For 3D arrays: "0,::factor,::factor"
  // For 4D arrays: "0,0,::factor,::factor"
  const prefix = arrayDims === 4 ? '0,0' : '0';
  const sliceExpr = `${prefix},::${downsampleFactor},::${downsampleFactor}`;
  return fetchThumbnail(path, cmap, sliceExpr);
}

export async function downloadImage(path: string, filename: string): Promise<void> {
  const authHeader = await getValidAuthHeader();
  const url = getPngUrl(path);

  const response = await fetch(url, {
    headers: authHeader ? { Authorization: authHeader } : {},
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to download image: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';

  // Check if we got an error response instead of image
  if (contentType.includes('application/json')) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Server returned error instead of image');
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

export async function fetchArrayData(path: string): Promise<number[][]> {
  const url = `${API_BASE}/array/full/${path}?format=application/json`;
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch array: ${response.status}`);
  }
  return response.json();
}

// Tiled's structure.data_type — narrow view of just the fields we need to
// pick the right TypedArray. `kind` is numpy-style: 'f' float, 'i' signed,
// 'u' unsigned, 'c' complex.
export interface TiledDataType {
  kind: string;
  itemsize: number;
  endianness?: string;
}

export interface ArrayInfo {
  shape: number[];
  dtype: TiledDataType;
}

// One-shot fetch of an array's structural info (shape + dtype). Doesn't
// touch the bytes — pair with fetchArrayBytesIfChanged for polling.
export async function fetchArrayInfo(path: string): Promise<ArrayInfo> {
  const url = `${API_BASE}/metadata/${path}`;
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch array info: ${response.status}`);
  }
  const data = await response.json();
  const attrs = data?.attributes ?? data?.data?.attributes;
  const structure = attrs?.structure;
  return {
    shape: (structure?.shape as number[]) ?? [],
    dtype: (structure?.data_type as TiledDataType) ?? { kind: '?', itemsize: 0 },
  };
}

export type ArrayBytesResult =
  | { status: 'changed'; etag: string | null; buffer: ArrayBuffer }
  | { status: 'unchanged'; etag: string | null }
  | { status: 'error' };

// Fetch a sliced array as raw bytes with conditional revalidation. On 304
// (unchanged), no buffer is returned — caller keeps its previous render.
// `slice` matches Tiled's slice query param: a single number selects the
// leading dim, a string like "0,1" or ":,:" applies multi-dim slicing.
export async function fetchArrayBytesIfChanged(
  path: string,
  slice: number | string,
  lastEtag: string | null,
): Promise<ArrayBytesResult> {
  try {
    const authHeader = await getValidAuthHeader();
    const url = `${API_BASE}/array/full/${path}?format=application/octet-stream&slice=${slice}`;
    const headers: Record<string, string> = {};
    if (authHeader) headers['Authorization'] = authHeader;
    if (lastEtag) headers['If-None-Match'] = lastEtag;
    const response = await fetch(url, { headers });
    if (response.status === 304) {
      return { status: 'unchanged', etag: lastEtag };
    }
    if (!response.ok) {
      return { status: 'error' };
    }
    const etag = response.headers.get('ETag');
    const buffer = await response.arrayBuffer();
    return { status: 'changed', etag, buffer };
  } catch {
    return { status: 'error' };
  }
}

// Fetch a tiled array as raw little-endian bytes plus its shape.
// Caller wraps `buffer` in the appropriate TypedArray (Float32Array,
// Int32Array, …); we don't infer dtype because callers already know what
// they're reading. Used by viewers that need the raw values rather than a
// server-rendered PNG (e.g. the ViT mosaic stitcher).
export async function fetchArrayBuffer(
  path: string,
): Promise<{ buffer: ArrayBuffer; shape: number[] }> {
  const metaUrl = `${API_BASE}/metadata/${path}`;
  const dataUrl = `${API_BASE}/array/full/${path}?format=application/octet-stream`;
  const [metaResp, dataResp] = await Promise.all([
    fetchWithAuth(metaUrl),
    fetchWithAuth(dataUrl),
  ]);
  if (!metaResp.ok) {
    throw new Error(`Failed to fetch array metadata: ${metaResp.status}`);
  }
  if (!dataResp.ok) {
    throw new Error(`Failed to fetch array bytes: ${dataResp.status}`);
  }
  const meta = await metaResp.json();
  const attrs = meta?.attributes ?? meta?.data?.attributes;
  const shape: number[] = attrs?.structure?.shape ?? [];
  const buffer = await dataResp.arrayBuffer();
  return { buffer, shape };
}

// Convenience wrappers for the common dtypes we read.
export async function fetchFloat32Array(
  path: string,
): Promise<{ data: Float32Array; shape: number[] }> {
  const { buffer, shape } = await fetchArrayBuffer(path);
  return { data: new Float32Array(buffer), shape };
}

export async function fetchInt32Array(
  path: string,
): Promise<{ data: Int32Array; shape: number[] }> {
  const { buffer, shape } = await fetchArrayBuffer(path);
  return { data: new Int32Array(buffer), shape };
}

export async function fetchFloat64Array(
  path: string,
): Promise<{ data: Float64Array; shape: number[] }> {
  const { buffer, shape } = await fetchArrayBuffer(path);
  return { data: new Float64Array(buffer), shape };
}

// Fetch table data from tiled as JSON (converts columnar to row format)
export async function fetchTableData(path: string): Promise<Record<string, unknown>[]> {
  const url = `${API_BASE}/table/full/${path}?format=application/json`;
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch table: ${response.status}`);
  }
  const data = await response.json();
  // Tiled returns columnar format {col1: [...], col2: [...]} - convert to rows
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return columnarToRows(data as Record<string, unknown[]>);
  }
  return data;
}

// Find a reconstruction array path by matching scan_id
export async function findReconstructionByScanId(
  segmentationPath: string,
  scanId: string
): Promise<string | null> {
  // Check cache first - populated when reconstructions column is loaded
  const cachedReconstruction = reconstructionByScanId.get(scanId);
  if (cachedReconstruction) {
    // Get first array child from this reconstruction
    const children = await listChildren(cachedReconstruction.path, { limit: 10 });
    const firstArray = children.items.find(item => item.structureFamily === 'array');
    return firstArray?.path || null;
  }

  // Cache miss - query tiled directly for reconstruction with this scan_id
  const pathParts = segmentationPath.split('/');
  const reconstructionsPath = pathParts.slice(0, -1).join('/').replace('segmentations', 'reconstructions');

  try {
    // Query with scan_id filter
    const result = await listChildren(reconstructionsPath, {
      limit: 1,
      filters: {
        'filter[eq][condition][key]': 'scan_id',
        'filter[eq][condition][value]': scanId
      }
    });

    if (result.items.length > 0) {
      const match = result.items[0];
      // Cache it for future lookups
      reconstructionByScanId.set(scanId, match);
      // Get first array child from this reconstruction
      const children = await listChildren(match.path, { limit: 10 });
      const firstArray = children.items.find(item => item.structureFamily === 'array');
      return firstArray?.path || null;
    }
  } catch (e) {
    console.warn('Failed to find reconstruction for scan', scanId, e);
  }
  return null;
}

// Convert columnar table data to row format
function columnarToRows(data: Record<string, unknown[]>): Record<string, unknown>[] {
  const keys = Object.keys(data);
  if (keys.length === 0) return [];

  const length = (data[keys[0]] as unknown[]).length;
  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < length; i++) {
    const row: Record<string, unknown> = {};
    for (const key of keys) {
      row[key] = (data[key] as unknown[])[i];
    }
    rows.push(row);
  }
  return rows;
}

export { TILED_URL };
