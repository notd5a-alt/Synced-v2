# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Synced is a zero-trust peer-to-peer desktop app for 1-on-1 voice/video calls, text chat, and file sharing. All media and data flows directly between peers via WebRTC (encrypted with DTLS-SRTP). The signaling server only relays connection setup messages — it never sees user content.

## Setup

```bash
pip install -e ".[dev]"          # Python deps (FastAPI, Uvicorn, pytest, etc.)
cd frontend && npm install       # Frontend deps
```

## Commands

### Frontend (from `frontend/`)
- `npm run dev` — Vite dev server on 0.0.0.0 (proxies `/ws` and `/api` to backend on port 9876)
- `npm run build` — builds React app into `backend/static/`
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run test` — Vitest (all frontend tests)
- `npm run test:watch` — Vitest in watch mode
- `npm run test:e2e` — Playwright end-to-end tests
- `npm run storybook` — Storybook on port 6006
- Single test: `npx vitest run src/hooks/useSignaling.test.ts`

### Backend
- `python app.py --port 9876` — runs backend server (use with Vite dev server or Tauri dev)
- `python -m pytest backend/tests/` — run all backend tests
- Single test: `python -m pytest backend/tests/test_api.py::test_info_returns_ip_and_port -v`
- Single file: `python -m pytest backend/tests/test_signaling.py -v`

### Full dev workflow (browser)
Run in two terminals:
1. `python app.py --dev` — backend on port 9876
2. `cd frontend && npm run dev` — frontend on port 5173, proxies API/WS to backend

### Tauri dev workflow
Run in two terminals:
1. `python app.py --dev` — backend on port 9876
2. `cd src-tauri && cargo tauri dev` — native window pointing at backend

### Tauri production build
```bash
cd frontend && npm run build           # build frontend → backend/static/
./scripts/build-sidecar.sh             # PyInstaller → src-tauri/binaries/
cd src-tauri && cargo tauri build       # produces platform installer
```

### HTTPS for LAN/phone testing
Place `certs/cert.pem` and `certs/key.pem` (e.g., from mkcert) in the project root. Vite auto-detects them and enables HTTPS. Required for `getUserMedia` on non-localhost origins.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Tauri Shell (native window)                                     │
│  └─ spawns Python sidecar → waits for ready → opens webview     │
│     └─ kills sidecar on window close                             │
└─────────────────────────────────────────────────────────────────┘
              │ webview loads http://localhost:9876
              ▼
┌─────────────────────┐     WebSocket      ┌──────────────────────┐
│   Peer A (browser)  │◄──── signaling ────►│   Peer B (browser)   │
│                     │     relay only      │                      │
│  React SPA          │                     │  React SPA           │
│  ├─ useSignaling    │     WebRTC P2P      │  ├─ useSignaling     │
│  ├─ useWebRTC    ◄──┼─── direct conn ────►┤  ├─ useWebRTC       │
│  ├─ useDataChannel  │  (audio/video/data) │  ├─ useDataChannel   │
│  └─ useFileTransfer │                     │  └─ useFileTransfer  │
└─────────────────────┘                     └──────────────────────┘
              │                                        │
              └────────── FastAPI backend (sidecar) ───┘
                   /ws (signaling relay)
                   /api/info (LAN IP)
                   static files (prod)
```

### Connection flow
1. Host creates room → backend assigns WebSocket slot → shows IP:port
2. Joiner connects to that IP:port → backend relays `peer-joined`
3. Host sends SDP offer → backend relays → Joiner sends SDP answer
4. ICE candidates exchanged → direct P2P connection established
5. All subsequent communication is peer-to-peer (no server involvement)

### Backend (`backend/`)
- `signaling.py` — `SignalingRoom` pairs exactly 2 WebSocket peers, relays messages between them. Sends `peer-joined`/`peer-disconnected` lifecycle events. Includes `TokenBucket` rate limiter (per-peer) and `RoomManager` for room lifecycle/cleanup.
- `main.py` — FastAPI app with security middleware (CSP, CORS with LAN auto-detection), access logging, and static file serving for production.

**API routes:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ws` or `/ws/{room_id}` | WebSocket | Signaling relay between paired peers |
| `/api/info` | GET | Returns `{"ip": LAN_IP, "port": port}` |
| `/api/rooms` | POST | Creates room, returns `{"room_code": code, "token": token}` |
| `/api/rooms/{code}` | GET | Checks if room exists/joinable, returns room token |
| `/api/ice-config` | GET | Returns STUN/TURN server list for WebRTC ICE |
| `/api/debug` | GET | Room state debug (only when `SYNCED_DEBUG=1`, localhost only) |

### Frontend hooks (`frontend/src/hooks/`)
These are the core logic layer — most bugs and features involve these files:
- `useSignaling.ts` — WebSocket wrapper with message buffering (prevents race conditions when messages arrive before handler is registered). Auto-reconnect with max 5 attempts.
- `useWebRTC.ts` — RTCPeerConnection lifecycle, media tracks, screen sharing, data channels. Uses the "polite peer" negotiation pattern (host=impolite, joiner=polite). All external state accessed via refs to avoid stale closures in callbacks. Derives HMAC key from DTLS fingerprints.
- `useDataChannel.ts` — text messaging, reactions, typing indicators, read receipts, and presence over the "chat" data channel
- `useFileTransfer.ts` — chunked binary file transfer (16KB chunks) over the "file" data channel with flow control via `bufferedAmountLowThreshold`. Supports GZIP compression, SHA-256 checksums, and resumable transfers (500MB limit).
- `useConnectionMonitor.ts` — WebRTC stats polling, bandwidth tier detection, adaptive bitrate scaling, ICE restart logic, packet loss/RTT/codec tracking
- `useNoiseSuppression.ts` — RNNoise AI denoiser via WASM + Web Audio API, lazy-loaded, integrates via `replaceTrack`
- `useVAD.ts` — Voice Activity Detection using frequency-weighted amplitude analysis (100ms polling, 300ms debounce)
- `useTheme.ts` — 7 themes (Terminal, Phosphor, Amber, Cyberpunk, Arctic, Blood, Snow) with optional CRT scanline overlay
- `useAudioDevices.ts` — Microphone/speaker device enumeration and dynamic switching
- `useMicLevel.ts` — Real-time microphone level via AnalyserNode FFT data

### Frontend utilities (`frontend/src/utils/`)
- `channelAuth.ts` — HMAC-SHA256 message signing/verification derived from DTLS fingerprints
- `codecConfig.ts` — Preferred codec ordering for WebRTC (VP9/VP8 video, Opus audio)
- `compression.ts` — GZIP compress/decompress wrappers for file transfer
- `sounds.ts` — UI sound effects (ringtone, connect, disconnect)

### Frontend state machine (`App.tsx`)
Screens: `home` → `lobby` → `session`. Session has three tabs: Chat, Call, Files. Transitions are driven by `webrtc.connectionState` changes. Animated screen transitions (150ms exit, 250ms enter). `fullReset()` provides idempotent cleanup of all signaling/WebRTC/audio state.

### Tauri sidecar (`src-tauri/src/main.rs`)
Manages the Python backend as a child process. Detects and kills stale sidecar processes by port/process-name. On Windows, uses Job Objects (`KILL_ON_JOB_CLOSE`) to guarantee cleanup if the app crashes. On all platforms, the sidecar watches its stdin — when the pipe breaks (parent dies), it force-exits. Health-checks the webview after 5s and shows diagnostics on failure.

## Key Patterns

- **Refs over state in WebRTC callbacks**: `signalingRef`, `isHostRef`, `pcRef`, etc. ensure event handlers always read current values without re-registering. This is critical — using state directly in `useCallback` deps caused infinite re-renders and duplicate peer connections in the past.
- **Message buffering in useSignaling**: Messages arriving before `onMessage(handler)` is called are queued and flushed when the handler registers. This prevents the host's offer from being dropped during initialization.
- **`replaceTrack` for screen sharing**: Screen video swaps the camera sender's track (no renegotiation needed). `addTrack` is only used when no video sender exists yet.
- **`screenVideoSenderRef`**: Tracks the video sender used for screen sharing so it can be reused across share/stop cycles (prevents sender accumulation when the sender has a null track).
- **No state management library**: All state lives in React hooks + refs. No Redux, Zustand, etc.
- **Custom CSS theming**: No Tailwind — uses CSS custom properties (`--bg`, `--surface`, `--accent`, etc.) in `frontend/src/styles/index.css` with monospace fonts (JetBrains Mono, Space Grotesk). Theme switching toggles CSS classes.
- **Server URL resolution**: `frontend/src/config.ts` resolves the signaling server URL — supports local mode (same origin) and remote mode (env var `SYNCED_SIGNALING_URL`).
- **ESLint intentional overrides**: `@typescript-eslint/no-explicit-any` is off (WebRTC APIs require `any`). Several `react-hooks/*` rules are off to support the refs-over-state pattern.

## Environment Variables

Configured via `.env` (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `TURN_URL` | — | TURN server URL (e.g., `turn:server:3478`) |
| `TURN_USERNAME` | — | TURN auth username |
| `TURN_CREDENTIAL` | — | TURN auth credential |
| `SYNCED_DEBUG` | `0` | Enable `/api/debug` endpoint (localhost only) |
| `LOG_LEVEL` | `INFO` | Python logging level |
| `SYNCED_ALLOWED_ORIGINS` | auto | Comma-separated allowed CORS origins, or `*` for all |
| `SYNCED_MAX_ROOMS` | `100` | Max concurrent signaling rooms |
| `SYNCED_HEARTBEAT_INTERVAL` | `30` | Seconds between WebSocket pings |
| `SYNCED_HEARTBEAT_TIMEOUT` | `300` | Max seconds without pong before disconnect |
| `SYNCED_IDLE_TIMEOUT` | `1800` | Max seconds with no signaling activity |
| `SYNCED_RATE_LIMIT` | `100` | Messages/second per peer |
| `SYNCED_RATE_BURST` | `200` | Token bucket burst size |
| `SYNCED_MAX_CONNECTIONS_PER_IP` | `4` | Max concurrent WebSocket connections per IP |
| `SYNCED_SIGNALING_URL` | — | Remote signaling server URL (disables local sidecar in Tauri) |
