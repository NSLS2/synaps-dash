# SYNAPS Pipeline Monitor

Real-time monitoring dashboard for the SYNAPS AI segmentation pipeline at NSLS-II. Track reconstructions and segmentation results as they flow through the beamline data pipeline via Tiled WebSocket subscriptions.

![Theme: Synchrotron Dark](https://img.shields.io/badge/theme-synchrotron%20dark-00e5ff)
![Next.js 14](https://img.shields.io/badge/Next.js-14-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)

## Features

- **Dynamic Column Monitoring** — Add columns to monitor any Tiled container path
- **Real-time Updates** — WebSocket subscriptions with auto-reconnect and glow animations
- **Infinite Scroll** — Paginated dataset loading with newest items first
- **Live Thumbnails** — Array visualizations rendered directly from Tiled
- **SVG Export** — Download publication-ready vector graphics
- **Metadata Explorer** — Detailed view with scan info, elements, ROI positions
- **Persistent Layout** — Monitor configurations saved to localStorage

## Tech Stack

- **Next.js 14** (App Router)
- **Framer Motion** (animations)
- **shadcn/ui + Tailwind CSS**
- **Synchrotron Theme** (dark mode, particle beam effects)

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Create a `.env.local` file:

```env
NEXT_PUBLIC_TILED_URL=https://tiled.nsls2.bnl.gov
```

## Usage

1. **Login** with your Tiled credentials
2. **Add Monitor** — Click the "Add Monitor" button
3. **Enter Path** — e.g., `tst/sandbox/synaps/reconstructions`
4. **View Datasets** — Scroll through items, click for details
5. **Export** — Download SVG from the detail panel

### Example Paths

```
tst/sandbox/synaps/reconstructions
tst/sandbox/synaps/segmentations
```

## Project Structure

```
synaps-dash/
├── app/
│   ├── layout.tsx              # Root layout with providers
│   ├── page.tsx                # Main dashboard
│   ├── globals.css             # Synchrotron theme
│   └── (auth)/login/page.tsx   # Login page
├── components/
│   ├── ui/                     # shadcn/ui components
│   ├── layout/header.tsx       # Header with live status
│   ├── monitor/
│   │   ├── monitor-column.tsx  # Reusable column component
│   │   ├── dataset-card.tsx    # Item card with thumbnail
│   │   ├── add-monitor-modal.tsx
│   │   └── empty-state.tsx
│   ├── detail/
│   │   ├── detail-panel.tsx    # Slide-out details
│   │   ├── array-viewer.tsx    # Full image display
│   │   └── svg-export-button.tsx
│   ├── visualizations/
│   │   └── particle-beam.tsx   # Animated canvas background
│   └── providers/
│       ├── auth-provider.tsx   # Authentication context
│       └── monitors-provider.tsx
├── lib/tiled/
│   ├── client.ts               # Tiled HTTP client
│   ├── auth.ts                 # Token management
│   ├── websocket.ts            # WebSocket subscriptions
│   └── types.ts                # TypeScript interfaces
└── hooks/
    ├── use-tiled-auth.ts
    ├── use-tiled-subscription.ts
    └── use-tiled-array.ts
```

## Theme

The dashboard uses a custom synchrotron/particle accelerator aesthetic:

| Variable | Color | Usage |
|----------|-------|-------|
| `--bg-void` | `#050508` | Base background |
| `--bg-chamber` | `#0a0c12` | Panel backgrounds |
| `--bg-elevated` | `#12151f` | Cards, elevated surfaces |
| `--beam-cyan` | `#00e5ff` | Primary accent |
| `--xray-purple` | `#8b5cf6` | Secondary accent |
| `--status-complete` | `#10b981` | Success states |
| `--status-processing` | `#f59e0b` | In-progress states |
| `--status-error` | `#ef4444` | Error states |

### Typography

- **Orbitron** — Display headings (futuristic, geometric)
- **JetBrains Mono** — Body/data text (monospace, technical)

### Visual Effects

- Particle beam canvas animation
- Scan-line CRT overlay
- Subtle grain texture
- New item glow animations
- Pulsing status indicators

## Tiled API Integration

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/search/{path}` | List children with pagination |
| `GET /api/v1/metadata/{path}` | Get item metadata |
| `GET /api/v1/array/full/{path}?format=image/png` | Thumbnail |
| `GET /api/v1/array/full/{path}?format=image/svg+xml` | SVG export |
| `WSS /api/v1/stream/single/{path}` | Real-time WebSocket updates |
| `POST /api/v1/auth/provider/{provider}/token` | Password authentication |
| `POST /api/v1/auth/session/refresh` | Token refresh |

## Development

```bash
# Type checking & linting
npm run lint

# Production build
npm run build

# Start production server
npm start
```

## Container / Docker

The app ships as a container image. The `Dockerfile` is a multi-stage build that
produces Next.js [standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
and runs it as a slim, non-root image (`node server.js` on port `3000`).

### Build & run locally

```bash
# Build
docker build -t synaps-dash .

# Run (SQLite fallback, ephemeral)
docker run --rm -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e ENTRA_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e ENTRA_TENANT_ID=... \
  -e ENTRA_CLIENT_ID=... \
  -e ENTRA_CLIENT_SECRET=... \
  -e TILED_SCOPE="api://<client-id>/access_as_user" \
  synaps-dash
```

### Image registry (GHCR)

A GitHub Actions workflow (`.github/workflows/build.yml`) builds the image and pushes
it to the GitHub Container Registry on every push to `main` (and via manual
`workflow_dispatch`):

```
ghcr.io/nsls2/synaps-dash:latest
ghcr.io/nsls2/synaps-dash:sha-<commit>
```

This repo **only builds and publishes** the image. Deployment is handled separately
(via an AAP / Ansible webhook that consumes the published image) and is out of scope
here.

### Runtime environment variables

Supplied at container runtime (none are baked into the image at build time):

| Variable | Required | Notes |
|----------|----------|-------|
| `ENTRA_TENANT_ID` | ✅ | Microsoft Entra (Azure AD) tenant ID |
| `ENTRA_CLIENT_ID` | ✅ | Entra OAuth client ID |
| `ENTRA_CLIENT_SECRET` | ✅ | Entra OAuth client secret |
| `SESSION_SECRET` | ✅ | Session signing key (≥32 chars) |
| `ENTRA_TOKEN_ENCRYPTION_KEY` | ✅ | Base64 32-byte key; **must stay stable** across restarts |
| `TILED_SCOPE` | ✅ | Tiled API scope, e.g. `api://<client-id>/access_as_user` |
| `DATABASE_URL` | ⬜ | `postgres://...` for shared/persistent storage; defaults to SQLite (see below) |
| `NEXT_PUBLIC_TILED_URL` | ⬜ | Defaults to `https://tiled.nsls2.bnl.gov` |
| `APP_BASE_URL` | ⬜ | App origin for OAuth callbacks (set in production) |

### Data persistence

The database only stores **encrypted Entra OAuth tokens** (a per-user credential
cache), and the app **creates its schema automatically at startup** — no migration
step is required in the container.

- **Postgres is optional.** With no `DATABASE_URL`, the app falls back to a SQLite file
  at `/app/data/app.sqlite` inside the container.
- That SQLite file is **ephemeral** — it is lost when the container is recreated, which
  just forces users to re-authenticate (no permanent data loss).
- To persist tokens across restarts on a single instance, mount a volume:
  `-v synaps-data:/app/data`.
- For production or **multiple replicas**, set `DATABASE_URL` to Postgres instead — a
  per-container SQLite file cannot be shared across replicas. In that case no volume is
  needed.

## Database Setup

The app uses a single `DATABASE_URL` for persistence. Supported values:

- `file:./data/app.sqlite` (default fallback)
- `postgres://...` or `postgresql://...`

Security note:

- Persisted Entra credentials are encrypted at the application layer.
- You must provide `ENTRA_TOKEN_ENCRYPTION_KEY` (base64-encoded 32 bytes).
- Generate with: `openssl rand -base64 32`
- Keep this key stable across restarts/deploys, or stored credentials become unreadable.

Initialize schema during deploy:

```bash
npm run db:migrate
```

Notes:

- For SQLite, the DB file and parent directory are created automatically if missing.
- The app also bootstraps the `entra_credentials` table at runtime if not present.
- Running `npm run db:migrate` is still recommended in deploy automation for fail-fast startup.

## WebSocket Events

The dashboard listens for `container-child-created` events:

```typescript
interface WebSocketMessage {
  type: 'container-child-created';
  sequence: number;
  timestamp: string;
  key: string;
  structure_family: 'array' | 'container' | 'table';
  metadata: Record<string, unknown>;
}
```

New items appear at the top with a cyan glow animation that fades over 3 seconds.

## License

Internal NSLS-II project.
