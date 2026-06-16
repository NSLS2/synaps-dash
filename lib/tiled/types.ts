export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token_expires_in: number;
}

export interface TiledUser {
  uuid: string;
  identities: Array<{
    id: string;
    provider: string;
  }>;
  roles?: string[];
}

/**
 * Unified user identity across Tiled and Entra sessions.
 */
export interface AppSessionUser {
  username: string;
  displayName: string;
  source: 'entra' | 'tiled';
  tiledUser?: TiledUser;
}

export interface TiledSearchResponse<T = TiledNode> {
  data: T[];
  links: {
    self: string;
    first: string | null;
    last: string | null;
    next: string | null;
    prev: string | null;
  };
  meta: {
    count: number;
  };
}

export interface TiledNode {
  id: string;
  attributes: {
    ancestors: string[];
    structure_family: 'array' | 'container' | 'table';
    specs: Array<{ name: string; version: string }>;
    metadata: Record<string, unknown>;
    structure?: {
      shape: number[];
      dims: string[] | null;
      chunks: number[][];
      resizable: boolean;
    };
    sorting: Array<{ key: string; direction: number }> | null;
    data_sources?: Array<{
      mimetype: string | null;
      structure_family: string;
      structure: Record<string, unknown>;
    }>;
  };
  links: {
    self: string;
    full?: string;
    block?: string;
    search?: string;
  };
  meta: {
    __parents__: string;
  };
}

export interface DatasetItem {
  id: string;
  path: string;
  metadata: Record<string, unknown>;
  structureFamily: 'array' | 'container' | 'table';
  specs?: string[];
  shape?: number[];
  timeCreated?: string;
  isNew?: boolean;
}

export interface ReconstructionMetadata {
  scan_id: number;
  element_list: string[];
  step_size: number;
  roi_positions: Record<string, number>;
  export_timestamp: number;
  start_doc?: {
    scan?: { type: string; scan_input: number[] };
  };
}

export interface BlobInfo {
  real_center_um: [number, number];
  real_size_um: [number, number];
  image_center: [number, number];
  element: string;
}

export interface SegmentationMetadata {
  scan_id: number;
  precomputed_blobs: {
    [element: string]: {
      [thresholdKey: string]: BlobInfo[];
    };
  };
  groups: {
    [groupName: string]: {
      elements: string[];
      unions: Record<string, unknown>;
      processing_mode: 'individual' | 'union';
    };
  };
}

export interface WebSocketMessage {
  type: 'container-child-created' | 'container-child-metadata-updated';
  sequence: number;
  timestamp: string;
  key: string;
  structure_family: 'array' | 'container' | 'table';
  metadata: Record<string, unknown>;
}

export interface MonitorConfig {
  id: string;
  path: string;
  label: string;
}
