import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PeerInfo } from "../hooks/useWebRTC";
import type { PeerAudioState } from "../hooks/useMultiChat";
import AudioVisualizer from "./AudioVisualizer";

export interface VideoTileInfo {
  peerId: string;
  stream: MediaStream;
  screenStream: MediaStream;
  speaking: boolean;
  connectionState: RTCPeerConnectionState;
}

interface TilePosition {
  x: number; // percentage of container width
  y: number; // percentage of container height
}

interface VideoGridProps {
  localStream: MediaStream | null;
  localSpeaking: boolean;
  localHasVideo: boolean;
  peers: Map<string, PeerInfo>;
  peerSpeaking: Map<string, boolean>;
  peerNames?: Map<string, string>;
  peersAudioState?: Map<string, PeerAudioState>;
  mutedForPeers?: Set<string>;
  onToggleMuteForPeer?: (peerId: string) => void;
  peersMutedForMe?: Map<string, boolean>;
  locallyMutedPeers?: Set<string>;
  onToggleLocalMutePeer?: (peerId: string) => void;
  streamRevision: number;
  localDisplayName?: string;
}

const DRAG_THRESHOLD = 3; // px — movement below this is a click, not a drag

// Tile dimensions: w = % of container width, aspect = width/height ratio
interface TileDim { w: number; aspect: number }

// Tile size categories
const DIM_AUDIO: TileDim = { w: 10, aspect: 1 };       // audio-only peers (small square)
const DIM_CAMERA: TileDim = { w: 16, aspect: 4 / 3 };  // camera tiles (4:3)
const DIM_SCREEN: TileDim = { w: 28, aspect: 16 / 9 }; // screen share tiles (16:9)

/** Convert tile dim to height-% given the container aspect ratio. */
function tileHeightPct(dim: TileDim, containerAR: number): number {
  // width is % of container width; height in px = (w% * cW) / aspect
  // height as % of container height = height_px / cH * 100
  //   = (w * cW / 100 / aspect) / cH * 100
  //   = w * (cW / cH) / aspect
  //   = w * containerAR / aspect
  return dim.w * containerAR / dim.aspect;
}

/** Check if two rectangles overlap (positions in %, sizes via TileDim). */
function rectsOverlap(
  a: TilePosition, adim: TileDim,
  b: TilePosition, bdim: TileDim,
  ar: number,
  margin = 2,
): boolean {
  const ah = tileHeightPct(adim, ar);
  const bh = tileHeightPct(bdim, ar);
  return (
    a.x < b.x + bdim.w + margin &&
    a.x + adim.w + margin > b.x &&
    a.y < b.y + bh + margin &&
    a.y + ah + margin > b.y
  );
}

/**
 * Find the nearest non-overlapping position for a new tile,
 * searching in a spiral pattern outward from a target point.
 */
function findNearestEmpty(
  target: TilePosition,
  dim: TileDim,
  occupied: { pos: TilePosition; dim: TileDim }[],
  ar: number,
): TilePosition {
  const stepX = dim.w + 3;
  const stepY = tileHeightPct(dim, ar) + 3;

  for (let ring = 0; ring <= 10; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const candidate = {
          x: target.x + dx * stepX,
          y: target.y + dy * stepY,
        };
        const overlaps = occupied.some((o) =>
          rectsOverlap(candidate, dim, o.pos, o.dim, ar),
        );
        if (!overlaps) return candidate;
      }
    }
  }
  return { x: target.x, y: target.y + (occupied.length + 1) * stepY };
}

/** Compute initial grid layout for the first batch of tiles. */
function computeDefaultPositions(
  tileKeys: string[],
  getDim: (key: string) => TileDim,
  ar: number,
): Map<string, TilePosition> {
  const count = tileKeys.length;
  if (count === 0) return new Map();
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = 100 / cols;
  const cellH = 100 / rows;
  const result = new Map<string, TilePosition>();
  tileKeys.forEach((key, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const d = getDim(key);
    const h = tileHeightPct(d, ar);
    result.set(key, {
      x: col * cellW + (cellW - d.w) / 2,
      y: row * cellH + (cellH - h) / 2,
    });
  });
  return result;
}

/**
 * Spatial canvas layout for 1-8 video participants.
 * Tiles can be freely dragged to any position.
 * Double-clicking a tile expands it to fill the view.
 * Middle-click + drag pans the infinite canvas.
 * Lines connect each peer's camera tile to their screen share tile.
 */
export default function VideoGrid({
  localStream,
  localSpeaking,
  localHasVideo,
  peers,
  peerSpeaking,
  peerNames,
  peersAudioState,
  mutedForPeers,
  onToggleMuteForPeer,
  peersMutedForMe,
  locallyMutedPeers,
  onToggleLocalMutePeer,
  streamRevision,
  localDisplayName,
}: VideoGridProps) {
  const [expandedTile, setExpandedTile] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, TilePosition>>(new Map());
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [containerAR, setContainerAR] = useState(16 / 9); // width/height
  const containerRef = useRef<HTMLDivElement>(null);

  // Track container aspect ratio for correct tile height calculations
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (height > 0) setContainerAR(width / height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Refs for drag state (avoids stale closures in pointer handlers)
  const draggingRef = useRef<{
    key: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const wasDraggedRef = useRef(false);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  // Refs for middle-click canvas panning
  const panningRef = useRef<{
    startX: number;
    startY: number;
    origOffsetX: number;
    origOffsetY: number;
  } | null>(null);
  const canvasOffsetRef = useRef(canvasOffset);
  canvasOffsetRef.current = canvasOffset;

  // Build tile list
  const tiles = useMemo(() => {
    const list: VideoTileInfo[] = [];
    for (const [, peer] of peers) {
      list.push({
        peerId: peer.peerId,
        stream: peer.remoteStream,
        screenStream: peer.remoteScreenStream,
        speaking: peerSpeaking.get(peer.peerId) ?? false,
        connectionState: peer.connectionState,
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, peerSpeaking, streamRevision]);

  // Active screen shares
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activeScreenShares = useMemo(
    () =>
      tiles.filter((t) =>
        t.screenStream
          .getVideoTracks()
          .some((tr) => tr.readyState === "live" && !tr.muted),
      ),
    [tiles, streamRevision],
  );

  // All tile keys in render order
  const allTileKeys = useMemo(() => {
    const keys = ["local"];
    for (const t of tiles) keys.push(t.peerId);
    for (const t of activeScreenShares) keys.push(`screen-${t.peerId}`);
    return keys;
  }, [tiles, activeScreenShares]);

  // Per-tile dimensions based on tile type
  const getDim = useCallback((key: string): TileDim => {
    if (key.startsWith("screen-")) return DIM_SCREEN;
    if (key === "local") return localHasVideo ? DIM_CAMERA : DIM_AUDIO;
    // Remote peer — check if they have video
    const tile = tiles.find((t) => t.peerId === key);
    if (tile) {
      const hasVid = tile.stream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
      return hasVid ? DIM_CAMERA : DIM_AUDIO;
    }
    return DIM_CAMERA;
  }, [tiles, localHasVideo]);

  // Memoized dims map for stable reference
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tileDims = useMemo(() => {
    const m = new Map<string, TileDim>();
    for (const key of allTileKeys) m.set(key, getDim(key));
    return m;
  }, [allTileKeys, getDim, streamRevision]);

  // Initialize positions for new tiles, remove stale ones
  useEffect(() => {
    setPositions((prev) => {
      const keySet = new Set(allTileKeys);
      const newKeys = allTileKeys.filter((k) => !prev.has(k));
      const staleKeys = [...prev.keys()].filter((k) => !keySet.has(k));

      if (newKeys.length === 0 && staleKeys.length === 0) return prev;

      const next = new Map(prev);
      for (const k of staleKeys) next.delete(k);

      if (newKeys.length > 0) {
        const existingPositions = [...next.entries()];

        if (existingPositions.length === 0) {
          // First batch — use grid layout
          const defaults = computeDefaultPositions(newKeys, getDim, containerAR);
          for (const [k, v] of defaults) next.set(k, v);
        } else {
          // Place each new tile near existing tiles
          for (const key of newKeys) {
            const dim = getDim(key);
            let target: TilePosition;
            const isScreen = key.startsWith("screen-");
            const parentPeerId = isScreen ? key.replace("screen-", "") : null;
            const parentPos = parentPeerId ? next.get(parentPeerId) : null;
            const parentDim = parentPeerId ? getDim(parentPeerId) : null;

            if (parentPos && parentDim) {
              target = { x: parentPos.x + parentDim.w + 3, y: parentPos.y };
            } else {
              const vals = [...next.values()];
              const cx = vals.reduce((s, p) => s + p.x, 0) / vals.length;
              const cy = vals.reduce((s, p) => s + p.y, 0) / vals.length;
              target = { x: cx, y: cy };
            }

            const allOccupied = [...next.entries()].map(([k, pos]) => ({
              pos,
              dim: tileDims.get(k) ?? getDim(k),
            }));
            const pos = findNearestEmpty(target, dim, allOccupied, containerAR);
            next.set(key, pos);
          }
        }
      }
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTileKeys, getDim, tileDims, containerAR]);

  // Connector lines between peer camera tiles and their screen share tiles
  const connectorLines = useMemo(() => {
    const lines: { fromCx: number; fromCy: number; toCx: number; toCy: number; peerId: string }[] = [];
    for (const ss of activeScreenShares) {
      const camPos = positions.get(ss.peerId);
      const screenPos = positions.get(`screen-${ss.peerId}`);
      if (camPos && screenPos) {
        const camDim = tileDims.get(ss.peerId) ?? DIM_CAMERA;
        const scrDim = tileDims.get(`screen-${ss.peerId}`) ?? DIM_SCREEN;
        const camH = tileHeightPct(camDim, containerAR);
        const scrH = tileHeightPct(scrDim, containerAR);
        lines.push({
          fromCx: camPos.x + camDim.w / 2,
          fromCy: camPos.y + camH / 2,
          toCx: screenPos.x + scrDim.w / 2,
          toCy: screenPos.y + scrH / 2,
          peerId: ss.peerId,
        });
      }
    }
    return lines;
  }, [activeScreenShares, positions, tileDims, containerAR]);

  // Reset expanded tile if screen share ends
  useEffect(() => {
    if (!expandedTile) return;
    const stillActive = activeScreenShares.some(
      (t) => `screen-${t.peerId}` === expandedTile,
    );
    if (!stillActive) setExpandedTile(null);
  }, [expandedTile, activeScreenShares]);

  const handleTileDoubleClick = useCallback((tileKey: string) => {
    if (wasDraggedRef.current) return;
    setExpandedTile((prev) => (prev === tileKey ? null : tileKey));
  }, []);

  // --- Drag handlers ---
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, key: string) => {
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const pos = positionsRef.current.get(key);
      if (!pos) return;

      e.currentTarget.setPointerCapture(e.pointerId);
      wasDraggedRef.current = false;
      draggingRef.current = {
        key,
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
      };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;
      const container = containerRef.current;
      if (!container) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;

      if (
        !wasDraggedRef.current &&
        Math.abs(dx) < DRAG_THRESHOLD &&
        Math.abs(dy) < DRAG_THRESHOLD
      ) {
        return;
      }
      wasDraggedRef.current = true;
      setDraggingKey(drag.key);

      const rect = container.getBoundingClientRect();
      const pxToPercentX = (100 / rect.width) * dx;
      const pxToPercentY = (100 / rect.height) * dy;

      const newX = drag.origX + pxToPercentX;
      const newY = drag.origY + pxToPercentY;

      setPositions((prev) => {
        const next = new Map(prev);
        next.set(drag.key, { x: newX, y: newY });
        return next;
      });
    },
    [],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (draggingRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      draggingRef.current = null;
      setDraggingKey(null);
      if (wasDraggedRef.current) {
        setTimeout(() => { wasDraggedRef.current = false; }, 0);
      }
    }
  }, []);

  // --- Canvas pan handlers (middle-click) ---
  const handleCanvasPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panningRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origOffsetX: canvasOffsetRef.current.x,
      origOffsetY: canvasOffsetRef.current.y,
    };
    setIsPanning(true);
  }, []);

  const handleCanvasPointerMove = useCallback((e: React.PointerEvent) => {
    const pan = panningRef.current;
    if (!pan) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    setCanvasOffset({ x: pan.origOffsetX + dx, y: pan.origOffsetY + dy });
  }, []);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    if (panningRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      panningRef.current = null;
      setIsPanning(false);
    }
  }, []);

  // --- Expanded mode: show selected screen share full-view ---
  if (expandedTile) {
    const screenPeerId = expandedTile.replace("screen-", "");
    const screenTile = activeScreenShares.find((t) => t.peerId === screenPeerId);
    if (screenTile) {
      return (
        <div className="grid-expanded" onDoubleClick={() => setExpandedTile(null)}>
          <ScreenShareTile
            peerId={screenTile.peerId}
            screenStream={screenTile.screenStream}
            streamRevision={streamRevision}
            expanded={true}
          />
        </div>
      );
    }
  }

  // --- Spatial canvas mode ---
  return (
    <div
      className={`video-canvas${isPanning ? " panning" : ""}`}
      ref={containerRef}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
    >
      <div
        className="canvas-inner"
        style={{ transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px)` }}
      >
        {/* SVG connector lines between peer camera and screen share tiles */}
        {connectorLines.length > 0 && (
          <svg className="canvas-connectors">
            {connectorLines.map((line) => (
              <line
                key={`line-${line.peerId}`}
                x1={`${line.fromCx}%`}
                y1={`${line.fromCy}%`}
                x2={`${line.toCx}%`}
                y2={`${line.toCy}%`}
                className="canvas-connector-line"
              />
            ))}
          </svg>
        )}

        {allTileKeys.map((key) => {
          const pos = positions.get(key) ?? { x: 0, y: 0 };
          const dim = tileDims.get(key) ?? getDim(key);
          const isDragging = draggingKey === key;

          return (
            <div
              key={key}
              className={`canvas-tile${isDragging ? " dragging" : ""}`}
              style={{
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                width: `${dim.w}%`,
                aspectRatio: `${dim.aspect}`,
              }}
              onPointerDown={(e) => handlePointerDown(e, key)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onDoubleClick={() => handleTileDoubleClick(key)}
            >
              {key === "local" ? (
                <LocalTile
                  stream={localStream}
                  speaking={localSpeaking}
                  hasVideo={localHasVideo}
                  displayName={localDisplayName}
                />
              ) : key.startsWith("screen-") ? (
                (() => {
                  const peerId = key.replace("screen-", "");
                  const t = activeScreenShares.find((s) => s.peerId === peerId);
                  return t ? (
                    <ScreenShareTile
                      peerId={t.peerId}
                      displayName={peerNames?.get(t.peerId)}
                      screenStream={t.screenStream}
                      streamRevision={streamRevision}
                      expanded={false}
                    />
                  ) : null;
                })()
              ) : (
                (() => {
                  const t = tiles.find((tile) => tile.peerId === key);
                  return t ? (
                    <RemoteTile
                      tile={t}
                      displayName={peerNames?.get(t.peerId)}
                      streamRevision={streamRevision}
                      audioState={peersAudioState?.get(t.peerId)}
                      isMutedForPeer={mutedForPeers?.has(t.peerId) ?? false}
                      onToggleMuteForPeer={onToggleMuteForPeer}
                      peerMutedMe={peersMutedForMe?.get(t.peerId) ?? false}
                      isLocallyMuted={locallyMutedPeers?.has(t.peerId) ?? false}
                      onToggleLocalMutePeer={onToggleLocalMutePeer}
                    />
                  ) : null;
                })()
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local video tile
// ---------------------------------------------------------------------------
function LocalTile({
  stream,
  speaking,
  hasVideo,
  displayName,
}: {
  stream: MediaStream | null;
  speaking: boolean;
  hasVideo: boolean;
  displayName?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    const hasLiveVideo = stream
      ?.getVideoTracks()
      .some((t) => t.readyState === "live");
    videoRef.current.srcObject = hasLiveVideo ? stream : null;
  }, [stream]);

  return (
    <div className={`video-tile ${speaking ? "speaking" : ""}`}>
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="tile-video mirror"
        />
      ) : stream ? (
        <div className="tile-audio-only">
          <AudioVisualizer stream={stream} />
        </div>
      ) : (
        <div className="tile-placeholder">YOU</div>
      )}
      <span className="tile-label">{displayName || "You"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote peer video tile
// ---------------------------------------------------------------------------
function RemoteTile({
  tile,
  displayName,
  streamRevision,
  audioState,
  isMutedForPeer,
  onToggleMuteForPeer,
  peerMutedMe,
  isLocallyMuted,
  onToggleLocalMutePeer,
}: {
  tile: VideoTileInfo;
  displayName?: string;
  streamRevision: number;
  audioState?: PeerAudioState;
  isMutedForPeer: boolean;
  onToggleMuteForPeer?: (peerId: string) => void;
  peerMutedMe: boolean;
  isLocallyMuted: boolean;
  onToggleLocalMutePeer?: (peerId: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevStreamRef = useRef<MediaStream | null>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasVideo = useMemo(
    () =>
      tile.stream
        .getVideoTracks()
        .some((t) => t.readyState === "live" && !t.muted),
    [tile.stream, streamRevision],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasAudio = useMemo(
    () => tile.stream.getAudioTracks().some((t) => t.readyState === "live"),
    [tile.stream, streamRevision],
  );

  useEffect(() => {
    if (videoRef.current && tile.stream !== prevStreamRef.current) {
      videoRef.current.srcObject = tile.stream;
      prevStreamRef.current = tile.stream;
    }
  }, [tile.stream, streamRevision]);

  // Close context menu on escape
  useEffect(() => {
    if (!showContextMenu) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowContextMenu(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [showContextMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const label = displayName || tile.peerId.slice(0, 8);
  const disconnected =
    tile.connectionState === "failed" ||
    tile.connectionState === "disconnected";

  return (
    <div
      className={`video-tile ${tile.speaking ? "speaking" : ""} ${disconnected ? "disconnected" : ""}`}
      onContextMenu={handleContextMenu}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="tile-video"
        />
      ) : hasAudio ? (
        <div className="tile-audio-only">
          <AudioVisualizer stream={tile.stream} />
          {tile.speaking && (
            <span className="tile-speaking-badge">Speaking</span>
          )}
        </div>
      ) : (
        <div className="tile-placeholder">
          {tile.connectionState === "failed"
            ? `CANNOT CONNECT TO ${label}`
            : tile.connectionState === "disconnected"
              ? "RECONNECTING..."
              : "CONNECTING..."}
        </div>
      )}
      <span className="tile-label">
        {label}
        {audioState?.muted && (
          <span className="tile-muted-badge" title="Muted">
            MIC OFF
          </span>
        )}
        {audioState?.deafened && (
          <span className="tile-deafened-badge" title="Deafened">
            DEAF
          </span>
        )}
        {isLocallyMuted && (
          <span
            className="tile-locally-muted-badge"
            title="You muted this peer's audio"
          >
            MUTED
          </span>
        )}
        {isMutedForPeer && (
          <span
            className="tile-selective-mute-badge"
            title="You muted your mic for this peer"
          >
            YOU: MUTED
          </span>
        )}
        {peerMutedMe && (
          <span
            className="tile-peer-muted-me-badge"
            title="This peer muted their mic for you"
          >
            MUTED YOU
          </span>
        )}
      </span>
      {showContextMenu && createPortal(
        <>
          <div
            className="tile-context-backdrop"
            onMouseDown={() => setShowContextMenu(false)}
          />
          <div
            ref={menuRef}
            className="tile-context-menu"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            {onToggleLocalMutePeer && (
              <button
                className="tile-context-menu-item"
                onMouseDown={() => {
                  onToggleLocalMutePeer(tile.peerId);
                  setShowContextMenu(false);
                }}
              >
                {isLocallyMuted ? "Unmute this peer" : "Mute this peer"}
              </button>
            )}
            {onToggleMuteForPeer && (
              <button
                className="tile-context-menu-item"
                onMouseDown={() => {
                  onToggleMuteForPeer(tile.peerId);
                  setShowContextMenu(false);
                }}
              >
                {isMutedForPeer
                  ? "Unmute your mic for this peer"
                  : "Mute your mic for this peer"}
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen share tile — double-click to expand/collapse
// ---------------------------------------------------------------------------
function ScreenShareTile({
  peerId,
  displayName,
  screenStream,
  streamRevision,
  expanded,
}: {
  peerId: string;
  displayName?: string;
  screenStream: MediaStream;
  streamRevision: number;
  expanded: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasVideo = useMemo(
    () =>
      screenStream
        .getVideoTracks()
        .some((t) => t.readyState === "live" && !t.muted),
    [screenStream, streamRevision],
  );

  useEffect(() => {
    if (videoRef.current && hasVideo) {
      videoRef.current.srcObject = screenStream;
    }
  }, [screenStream, hasVideo]);

  const label = displayName || peerId.slice(0, 8);

  return (
    <div
      className={`video-tile screen-share-tile ${expanded ? "expanded" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={
        expanded
          ? "Return to grid view"
          : `Expand screen share from ${label}`
      }
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="tile-video"
      />
      <span className="tile-label">{label} — Screen</span>
      {expanded && (
        <span className="tile-expand-hint">Double-click to return</span>
      )}
      {!expanded && (
        <span className="tile-expand-hint">Double-click to expand</span>
      )}
    </div>
  );
}
