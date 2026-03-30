import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PeerInfo } from "../hooks/useWebRTC";
import type { PeerAudioState } from "../hooks/useMultiChat";
import { useSpatialInteraction } from "../hooks/useSpatialInteraction";
import AudioVisualizer from "./AudioVisualizer";
import { generateUserPalette } from "../utils/colorPalette";
import type { TilePosition, TileDim } from "../utils/tileGeometry";
import {
  DIM_AUDIO, DIM_CAMERA, DIM_SCREEN,
  clipLineToEdges,
  findNearestEmpty, computeDefaultPositions,
} from "../utils/tileGeometry";


export interface VideoTileInfo {
  peerId: string;
  stream: MediaStream;
  screenStream: MediaStream;
  speaking: boolean;
  connectionState: RTCPeerConnectionState;
}

interface VideoGridProps {
  localStream: MediaStream | null;
  localSpeaking: boolean;
  localHasVideo: boolean;
  screenStream?: MediaStream | null;
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
  localProfilePic?: string;
  peerAvatars?: Map<string, string>;
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
  screenStream,
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
  localProfilePic,
  peerAvatars,
}: VideoGridProps) {
  const [expandedTile, setExpandedTile] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, TilePosition>>(new Map());
  const [customWidths, setCustomWidths] = useState<Map<string, number>>(new Map());
  const [containerAR, setContainerAR] = useState(16 / 9); // width/height
  const [watchingScreens, setWatchingScreens] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasInnerRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

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

  // Is the local user actively screen sharing?
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localScreenActive = useMemo(
    () =>
      !!screenStream &&
      screenStream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted),
    [screenStream, streamRevision],
  );

  // All tile keys in render order
  const allTileKeys = useMemo(() => {
    const keys = ["local"];
    if (localScreenActive) keys.push("screen-local");
    for (const t of tiles) keys.push(t.peerId);
    for (const t of activeScreenShares) keys.push(`screen-${t.peerId}`);
    return keys;
  }, [tiles, activeScreenShares, localScreenActive]);

  // Stable per-user color palette: local=0, peers sorted by ID for consistency
  const userColors = useMemo(() => {
    const peerIds = tiles.map((t) => t.peerId).sort();
    const userCount = 1 + peerIds.length; // local + peers
    const palette = generateUserPalette(userCount);
    const map = new Map<string, string>();
    map.set("local", palette[0]);
    peerIds.forEach((id, i) => map.set(id, palette[i + 1]));
    return map;
  }, [tiles]);

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

  // Memoized dims map — merges default dims with any custom widths (aspect preserved)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tileDims = useMemo(() => {
    const m = new Map<string, TileDim>();
    for (const key of allTileKeys) {
      const base = getDim(key);
      const cw = customWidths.get(key);
      m.set(key, cw != null ? { w: cw, aspect: base.aspect } : base);
    }
    return m;
  }, [allTileKeys, getDim, streamRevision, customWidths]);

  // Initialize positions for new tiles, remove stale ones
  useEffect(() => {
    setPositions((prev) => {
      const keySet = new Set(allTileKeys);
      const newKeys = allTileKeys.filter((k) => !prev.has(k));
      const staleKeys = [...prev.keys()].filter((k) => !keySet.has(k));

      if (newKeys.length === 0 && staleKeys.length === 0) return prev;

      const next = new Map(prev);
      for (const k of staleKeys) next.delete(k);

      // Clean up custom widths for removed tiles
      if (staleKeys.length > 0) {
        setCustomWidths((cw) => {
          const hasSome = staleKeys.some((k) => cw.has(k));
          if (!hasSome) return cw;
          const n = new Map(cw);
          for (const k of staleKeys) n.delete(k);
          return n;
        });
      }

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

  // Auto-watch local screen share; clean up stale entries
  useEffect(() => {
    setWatchingScreens((prev) => {
      const screenKeys = new Set(allTileKeys.filter((k) => k.startsWith("screen-")));
      let changed = false;
      const next = new Set(prev);

      // Auto-watch local screen share
      if (screenKeys.has("screen-local") && !next.has("screen-local")) {
        next.add("screen-local");
        changed = true;
      }

      // Remove watches for screen shares that no longer exist
      for (const k of prev) {
        if (!screenKeys.has(k)) {
          next.delete(k);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [allTileKeys]);

  const toggleWatching = useCallback((screenKey: string) => {
    setWatchingScreens((prev) => {
      const next = new Set(prev);
      if (next.has(screenKey)) {
        next.delete(screenKey);
      } else {
        next.add(screenKey);
      }
      return next;
    });
  }, []);

  // Spatial interaction: drag, resize, pan, spring animations
  const {
    draggingKey,
    resizingKey,
    isPanning,
    canvasOffset,
    wasDraggedRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
  } = useSpatialInteraction({
    containerRef,
    canvasInnerRef,
    positionsRef,
    tileDims,
    containerAR,
    setPositions,
    setCustomWidths,
  });

  // Connector lines between peer camera tiles and their screen share tiles
  const connectorLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; peerId: string; color: string }[] = [];

    // Local screen share connector
    if (localScreenActive) {
      const camPos = positions.get("local");
      const screenPos = positions.get("screen-local");
      if (camPos && screenPos) {
        const camDim = tileDims.get("local") ?? DIM_CAMERA;
        const scrDim = tileDims.get("screen-local") ?? DIM_SCREEN;
        const pts = clipLineToEdges(camPos, camDim, screenPos, scrDim, containerAR);
        if (pts) lines.push({ ...pts, peerId: "local", color: userColors.get("local") || "" });
      }
    }

    // Remote screen share connectors
    for (const ss of activeScreenShares) {
      const camPos = positions.get(ss.peerId);
      const screenPos = positions.get(`screen-${ss.peerId}`);
      if (camPos && screenPos) {
        const camDim = tileDims.get(ss.peerId) ?? DIM_CAMERA;
        const scrDim = tileDims.get(`screen-${ss.peerId}`) ?? DIM_SCREEN;
        const pts = clipLineToEdges(camPos, camDim, screenPos, scrDim, containerAR);
        if (pts) lines.push({ ...pts, peerId: ss.peerId, color: userColors.get(ss.peerId) || "" });
      }
    }
    return lines;
  }, [activeScreenShares, localScreenActive, positions, tileDims, containerAR, userColors]);

  // Reset expanded tile if the source disappears
  useEffect(() => {
    if (!expandedTile) return;
    if (expandedTile === "local") return; // local tile always exists
    if (expandedTile === "screen-local") {
      if (!localScreenActive) setExpandedTile(null);
      return;
    }
    if (expandedTile.startsWith("screen-")) {
      const stillActive = activeScreenShares.some(
        (t) => `screen-${t.peerId}` === expandedTile,
      );
      if (!stillActive) setExpandedTile(null);
      return;
    }
    // Remote camera tile — check peer still exists
    const peerExists = tiles.some((t) => t.peerId === expandedTile);
    if (!peerExists) setExpandedTile(null);
  }, [expandedTile, activeScreenShares, localScreenActive, tiles]);

  const handleTileDoubleClick = useCallback((tileKey: string) => {
    if (wasDraggedRef.current) return;
    setExpandedTile((prev) => (prev === tileKey ? null : tileKey));
  }, [wasDraggedRef]);

  // --- Expanded mode: show selected tile full-view ---
  if (expandedTile) {
    // Local camera tile
    if (expandedTile === "local") {
      return (
        <div className="grid-expanded" onDoubleClick={() => setExpandedTile(null)}>
          <LocalTile
            stream={localStream}
            speaking={localSpeaking}
            hasVideo={localHasVideo}
            displayName={localDisplayName}
            avatar={localProfilePic}
            userColor={userColors.get("local")}
            expanded={true}
          />
        </div>
      );
    }
    // Local screen share tile
    if (expandedTile === "screen-local" && screenStream && localScreenActive) {
      return (
        <div className="grid-expanded" onDoubleClick={() => setExpandedTile(null)}>
          <ScreenShareTile
            peerId="local"
            displayName={localDisplayName || "You"}
            screenStream={screenStream}
            streamRevision={streamRevision}
            userColor={userColors.get("local")}
            expanded={true}
            watching={true}
            onToggleWatch={() => {}}
          />
        </div>
      );
    }
    // Remote screen share tile
    if (expandedTile.startsWith("screen-")) {
      const screenPeerId = expandedTile.replace("screen-", "");
      const screenTile = activeScreenShares.find((t) => t.peerId === screenPeerId);
      if (screenTile) {
        return (
          <div className="grid-expanded" onDoubleClick={() => setExpandedTile(null)}>
            <ScreenShareTile
              peerId={screenTile.peerId}
              screenStream={screenTile.screenStream}
              streamRevision={streamRevision}
              userColor={userColors.get(screenTile.peerId)}
              expanded={true}
              watching={true}
              onToggleWatch={() => {}}
            />
          </div>
        );
      }
    }
    // Remote camera tile
    const remoteTile = tiles.find((t) => t.peerId === expandedTile);
    if (remoteTile) {
      return (
        <div className="grid-expanded" onDoubleClick={() => setExpandedTile(null)}>
          <RemoteTile
            tile={remoteTile}
            displayName={peerNames?.get(remoteTile.peerId)}
            avatar={peerAvatars?.get(remoteTile.peerId)}
            userColor={userColors.get(remoteTile.peerId)}
            streamRevision={streamRevision}
            audioState={peersAudioState?.get(remoteTile.peerId)}
            isMutedForPeer={mutedForPeers?.has(remoteTile.peerId) ?? false}
            onToggleMuteForPeer={onToggleMuteForPeer}
            peerMutedMe={peersMutedForMe?.get(remoteTile.peerId) ?? false}
            isLocallyMuted={locallyMutedPeers?.has(remoteTile.peerId) ?? false}
            onToggleLocalMutePeer={onToggleLocalMutePeer}
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
        ref={canvasInnerRef}
        style={{ transform: `translate(${canvasOffset.x}px, ${canvasOffset.y}px)` }}
      >
        {/* SVG connector lines */}
        {connectorLines.length > 0 && (
          <svg className="canvas-connectors" viewBox="0 0 100 100" preserveAspectRatio="none">
            {connectorLines.map((line) => {
              const pathD = `M ${line.x1} ${line.y1} L ${line.x2} ${line.y2}`;
              const lineColor = line.color || "var(--text-dim, rgba(255,255,255,0.3))";
              const isDrag = draggingKey != null && (draggingKey === line.peerId || draggingKey === `screen-${line.peerId}`) ||
                resizingKey != null && (resizingKey === line.peerId || resizingKey === `screen-${line.peerId}`);
              return (
                <g
                  key={`line-${line.peerId}`}
                  className={`connector-group${isDrag ? " dragging" : ""}`}
                  data-peer={line.peerId}
                  data-screen={`screen-${line.peerId}`}
                >
                  <path
                    d={pathD}
                    className="connector-line"
                    stroke={lineColor}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </svg>
        )}

        {allTileKeys.map((key) => {
          const pos = positions.get(key) ?? { x: 0, y: 0 };
          const dim = tileDims.get(key) ?? getDim(key);
          const isDragging = draggingKey === key;
          const isResizing = resizingKey === key;

          return (
            <div
              key={key}
              className={`canvas-tile${isDragging ? " dragging" : ""}${isResizing ? " resizing" : ""}`}
              style={{
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                width: `${dim.w}%`,
                aspectRatio: `${dim.aspect}`,
              }}
              onPointerDown={(e) => handlePointerDown(e, key)}
              onPointerMove={(e) => { handlePointerMove(e); handleResizePointerMove(e); }}
              onPointerUp={(e) => { handlePointerUp(e); handleResizePointerUp(e); }}
              onDoubleClick={() => handleTileDoubleClick(key)}
            >
              {key === "local" ? (
                <LocalTile
                  stream={localStream}
                  speaking={localSpeaking}
                  hasVideo={localHasVideo}
                  displayName={localDisplayName}
                  avatar={localProfilePic}
                  userColor={userColors.get("local")}
                />
              ) : key === "screen-local" ? (
                screenStream ? (
                  <ScreenShareTile
                    peerId="local"
                    displayName={localDisplayName || "You"}
                    screenStream={screenStream}
                    streamRevision={streamRevision}
                    userColor={userColors.get("local")}
                    expanded={false}
                    watching={watchingScreens.has("screen-local")}
                    onToggleWatch={() => toggleWatching("screen-local")}
                  />
                ) : null
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
                      userColor={userColors.get(t.peerId)}
                      expanded={false}
                      watching={watchingScreens.has(key)}
                      onToggleWatch={() => toggleWatching(key)}
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
                      avatar={peerAvatars?.get(t.peerId)}
                      userColor={userColors.get(t.peerId)}
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
              <div
                className="tile-resize-handle"
                onPointerDown={(e) => handleResizePointerDown(e, key)}
              />
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
  avatar,
  userColor,
  expanded = false,
}: {
  stream: MediaStream | null;
  speaking: boolean;
  hasVideo: boolean;
  displayName?: string;
  avatar?: string;
  userColor?: string;
  expanded?: boolean;
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
    <div
      className={`video-tile ${speaking ? "speaking" : ""} ${expanded ? "expanded" : ""}`}
      style={userColor ? { "--user-color": userColor } as React.CSSProperties : undefined}
    >
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
          <AudioVisualizer stream={stream} userColor={userColor} />
        </div>
      ) : (
        <div className="tile-placeholder">YOU</div>
      )}
      <span className="tile-label">
        {avatar && <img src={avatar} alt="" className="tile-avatar" />}
        {displayName || "You"}
      </span>
      {expanded && (
        <span className="tile-expand-hint">Double-click to return</span>
      )}
      {!expanded && (
        <span className="tile-expand-hint">Double-click to expand</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Remote peer video tile
// ---------------------------------------------------------------------------
function RemoteTile({
  tile,
  displayName,
  avatar,
  userColor,
  streamRevision,
  audioState,
  isMutedForPeer,
  onToggleMuteForPeer,
  peerMutedMe,
  isLocallyMuted,
  onToggleLocalMutePeer,
  expanded = false,
}: {
  tile: VideoTileInfo;
  displayName?: string;
  avatar?: string;
  userColor?: string;
  streamRevision: number;
  audioState?: PeerAudioState;
  isMutedForPeer: boolean;
  onToggleMuteForPeer?: (peerId: string) => void;
  peerMutedMe: boolean;
  isLocallyMuted: boolean;
  onToggleLocalMutePeer?: (peerId: string) => void;
  expanded?: boolean;
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
      className={`video-tile ${tile.speaking ? "speaking" : ""} ${disconnected ? "disconnected" : ""} ${expanded ? "expanded" : ""}`}
      style={userColor ? { "--user-color": userColor } as React.CSSProperties : undefined}
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
          <AudioVisualizer stream={tile.stream} userColor={userColor} />
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
        {avatar && <img src={avatar} alt="" className="tile-avatar" />}
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
      {expanded && (
        <span className="tile-expand-hint">Double-click to return</span>
      )}
      {!expanded && (
        <span className="tile-expand-hint">Double-click to expand</span>
      )}
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
// Screen share tile — lazy loaded, double-click to expand/collapse
// ---------------------------------------------------------------------------
function ScreenShareTile({
  peerId,
  displayName,
  screenStream,
  streamRevision,
  userColor,
  expanded,
  watching,
  onToggleWatch,
}: {
  peerId: string;
  displayName?: string;
  screenStream: MediaStream;
  streamRevision: number;
  userColor?: string;
  expanded: boolean;
  watching: boolean;
  onToggleWatch: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasVideo = useMemo(
    () =>
      screenStream
        .getVideoTracks()
        .some((t) => t.readyState === "live" && !t.muted),
    [screenStream, streamRevision],
  );

  // Only attach stream when watching
  useEffect(() => {
    if (!videoRef.current) return;
    if (watching && hasVideo) {
      videoRef.current.srcObject = screenStream;
    } else {
      videoRef.current.srcObject = null;
    }
  }, [screenStream, hasVideo, watching]);

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

  const label = displayName || peerId.slice(0, 8);

  return (
    <div
      className={`video-tile screen-share-tile ${expanded ? "expanded" : ""} ${!watching ? "not-watching" : ""}`}
      style={userColor ? { "--user-color": userColor } as React.CSSProperties : undefined}
      role="button"
      tabIndex={0}
      aria-label={
        !watching
          ? `Watch screen share from ${label}`
          : expanded
            ? "Return to grid view"
            : `Expand screen share from ${label}`
      }
      onContextMenu={handleContextMenu}
    >
      {watching ? (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="tile-video"
          />
          <span className="tile-label">{label} — Screen</span>
          {expanded && (
            <span className="tile-expand-hint">Double-click to return</span>
          )}
          {!expanded && (
            <span className="tile-expand-hint">Double-click to expand</span>
          )}
        </>
      ) : (
        <div className="screen-share-placeholder" onClick={onToggleWatch}>
          <span className="screen-share-placeholder-icon">⊞</span>
          <span className="screen-share-placeholder-label">{label} — Screen</span>
          <span className="screen-share-placeholder-hint">Click to watch</span>
        </div>
      )}
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
            <button
              className="tile-context-menu-item"
              onMouseDown={() => {
                onToggleWatch();
                setShowContextMenu(false);
              }}
            >
              {watching ? "Stop watching" : "Start watching"}
            </button>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
