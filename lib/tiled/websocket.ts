import { WebSocketMessage, DatasetItem } from './types';
import { getValidAccessToken, getAuthType } from './auth';

// Set to false to disable WebSockets entirely and use polling instead
export const WEBSOCKETS_ENABLED = true;

// Use our local WebSocket proxy to avoid browser header limitations
const USE_PROXY = true;

export interface ItemUpdate {
  key: string;
  path: string;
  structureFamily: 'array' | 'container' | 'table';
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface WebSocketOptions {
  onMessage: (item: DatasetItem) => void;
  onItemUpdated?: (update: ItemUpdate) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
  onMaxReconnectReached?: () => void;
  includeHistory?: boolean;
}

export class TiledWebSocket {
  private ws: WebSocket | null = null;
  private path: string;
  private options: WebSocketOptions;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3; // Fail fast and fall back to polling
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isManualClose = false;

  constructor(path: string, options: WebSocketOptions) {
    this.path = path;
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const token = await getValidAccessToken();
    const authType = getAuthType();

    let url: string;

    if (USE_PROXY) {
      // Connect to our local proxy which will add auth headers
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      url = `${wsProtocol}//${window.location.host}/api/ws/${this.path}`;

      // Pass token as query param to our proxy
      // For Entra sessions, don't send a token - the proxy reads httpOnly cookies
      const params = new URLSearchParams();
      if (authType !== 'entra' && token) {
        params.set('token', token);
        params.set('auth_type', authType || 'token');
      }
      if (this.options.includeHistory) {
        params.set('start', '0');
      }
      if (params.toString()) {
        url += `?${params.toString()}`;
      }
    } else {
      // Direct connection (won't work in browser due to header limitations)
      const TILED_URL = process.env.NEXT_PUBLIC_TILED_URL || 'https://tiled.nsls2.bnl.gov';
      const wsUrl = TILED_URL.replace('https://', 'wss://').replace('http://', 'ws://');
      url = `${wsUrl}/api/v1/stream/single/${this.path}`;

      if (this.options.includeHistory) {
        url += '?start=0';
      }
      if (token) {
        const paramName = authType === 'apikey' ? 'api_key' : 'access_token';
        const encodedToken = encodeURIComponent(token);
        url += `${url.includes('?') ? '&' : '?'}${paramName}=${encodedToken}`;
      }
    }

    console.log('[WebSocket] Connecting to:', url.replace(/token=[^&]+/, 'token=***'));
    console.log('[WebSocket] Using proxy:', USE_PROXY);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WebSocket] Connected successfully');
      this.reconnectAttempts = 0;
      this.options.onConnect?.();
    };

    this.ws.onmessage = (event) => {
      console.log('[WebSocket] Message received:', event.data.substring(0, 200));
      try {
        const msg = JSON.parse(event.data);

        // Handle proxy status messages
        if (msg.type === 'proxy-connected') {
          console.log('[WebSocket] Proxy connected to Tiled');
          return;
        }
        if (msg.type === 'proxy-error') {
          // Server-side issue (e.g., streaming not enabled for this catalog)
          console.warn('[WebSocket] Proxy error, falling back to polling:', msg.error);
          // If server returned 500, don't retry - streaming may not be supported
          if (msg.error?.includes('500') || msg.recoverable === false) {
            this.reconnectAttempts = this.maxReconnectAttempts; // Skip retries
          }
          return;
        }

        // Handle Tiled messages
        const tiledMsg = msg as WebSocketMessage;
        if (tiledMsg.type === 'container-child-created') {
          const item: DatasetItem = {
            id: tiledMsg.key,
            path: `${this.path}/${tiledMsg.key}`,
            metadata: tiledMsg.metadata,
            structureFamily: tiledMsg.structure_family,
            timeCreated: tiledMsg.timestamp,
            isNew: true,
          };
          this.options.onMessage(item);
        } else if (tiledMsg.type === 'container-child-metadata-updated') {
          this.options.onItemUpdated?.({
            key: tiledMsg.key,
            path: `${this.path}/${tiledMsg.key}`,
            structureFamily: tiledMsg.structure_family,
            metadata: tiledMsg.metadata,
            timestamp: tiledMsg.timestamp,
          });
        }
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[WebSocket] Closed:', { code: event.code, reason: event.reason, wasClean: event.wasClean });
      if (!this.isManualClose) {
        this.options.onDisconnect?.();
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (error) => {
      // WebSocket errors are recoverable — onclose will fire next and trigger reconnect or fallback to polling.
      // Use warn (not error) so Next.js dev overlay doesn't treat it as a fatal error.
      console.warn('[WebSocket] Error:', error);
      this.options.onError?.(error);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WebSocket] Max reconnect attempts reached, triggering fallback');
      this.options.onMaxReconnectReached?.();
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this.isManualClose = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export function createTiledWebSocket(path: string, options: WebSocketOptions): TiledWebSocket {
  return new TiledWebSocket(path, options);
}
