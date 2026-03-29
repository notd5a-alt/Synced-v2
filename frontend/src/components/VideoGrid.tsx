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
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [containerAR, setContainerAR] = useState(16 / 9); // width/height
  const [watchingScreens, setWatchingScreens] = useState<Set<string>>(new Set());
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
    el: HTMLElement | null; // direct DOM ref for perf
    currentX: number;
    currentY: number;
  } | null>(null);
  const wasDraggedRef = useRef(false);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  // Refs for resize state
  const resizingRef = useRef<{
    key: string;
    startX: number;
    origW: number; // original width in %
    el: HTMLElement | null;
    currentW: number;
  } | null>(null);
  const customWidthsRef = useRef(customWidths);
  customWidthsRef.current = customWidths;

  // Refs for middle-click canvas panning
  const panningRef = useRef<{
    startX: number;
    startY: number;
    origOffsetX: number;
    origOffsetY: number;
  } | null>(null);
  const canvasOffsetRef = useRef(canvasOffset);
  canvasOffsetRef.current = canvasOffset;
  const canvasInnerRef = useRef<HTMLDivElement>(null);

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

  // Connector lines between peer camera tiles and their screen share tiles
  const connectorLines = useMemo(() => {
    const lines: { fromCx: number; fromCy: number; toCx: number; toCy: number; peerId: string }[] = [];

    // Local screen share connector
    if (localScreenActive) {
      const camPos = positions.get("local");
      const screenPos = positions.get("screen-local");
      if (camPos && screenPos) {
        const camDim = tileDims.get("local") ?? DIM_CAMERA;
        const scrDim = tileDims.get("screen-local") ?? DIM_SCREEN;
        const camH = tileHeightPct(camDim, containerAR);
        const scrH = tileHeightPct(scrDim, containerAR);
        lines.push({
          fromCx: camPos.x + camDim.w / 2,
          fromCy: camPos.y + camH / 2,
          toCx: screenPos.x + scrDim.w / 2,
          toCy: screenPos.y + scrH / 2,
          peerId: "local",
        });
      }
    }

    // Remote screen share connectors
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
  }, [activeScreenShares, localScreenActive, positions, tileDims, containerAR]);

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
  }, []);

  // --- Drag handlers ---
  // Performance: during drag, we manipulate DOM directly (style.left/top)
  // and only commit to React state on pointerUp. This avoids re-rendering
  // the entire component tree (incl. Three.js visualizers) on every frame.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, key: string) => {
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const pos = positionsRef.current.get(key);
      if (!pos) return;

      const tileEl = e.currentTarget as HTMLElement;
      tileEl.setPointerCapture(e.pointerId);
      wasDraggedRef.current = false;
      draggingRef.current = {
        key,
        startX: e.clientX,
        startY: e.clientY,
        origX: pos.x,
        origY: pos.y,
        el: tileEl,
        currentX: pos.x,
        currentY: pos.y,
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

      if (!wasDraggedRef.current) {
        wasDraggedRef.current = true;
        setDraggingKey(drag.key);
      }

      const rect = container.getBoundingClientRect();
      const newX = drag.origX + (100 / rect.width) * dx;
      const newY = drag.origY + (100 / rect.height) * dy;

      drag.currentX = newX;
      drag.currentY = newY;

      // Direct DOM update — no React re-render
      if (drag.el) {
        drag.el.style.left = `${newX}%`;
        drag.el.style.top = `${newY}%`;
      }

      // Update connector SVG lines directly if this tile is connected
      const svgContainer = canvasInnerRef.current?.querySelector(".canvas-connectors");
      if (svgContainer) {
        const line = svgContainer.querySelector(`[data-peer="${drag.key}"], [data-screen="${drag.key}"]`) as SVGLineElement | null;
        if (line) {
          const dim = tileDims.get(drag.key);
          if (dim) {
            const h = tileHeightPct(dim, containerAR);
            const cx = newX + dim.w / 2;
            const cy = newY + h / 2;
            if (line.dataset.peer === drag.key) {
              line.setAttribute("x1", `${cx}%`);
              line.setAttribute("y1", `${cy}%`);
            } else {
              line.setAttribute("x2", `${cx}%`);
              line.setAttribute("y2", `${cy}%`);
            }
          }
        }
      }
    },
    [tileDims, containerAR],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = draggingRef.current;
    if (drag) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      // Commit final position to React state (single re-render)
      const finalX = drag.currentX;
      const finalY = drag.currentY;
      const key = drag.key;
      draggingRef.current = null;
      setDraggingKey(null);
      if (wasDraggedRef.current) {
        setPositions((prev) => {
          const next = new Map(prev);
          next.set(key, { x: finalX, y: finalY });
          return next;
        });
        setTimeout(() => { wasDraggedRef.current = false; }, 0);
      }
    }
  }, []);

  // --- Resize handlers ---
  // Same direct-DOM-manipulation pattern as drag for performance.
  // Only width changes; aspect ratio is locked via CSS aspectRatio.
  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, key: string) => {
      e.stopPropagation(); // prevent drag from starting
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const dim = customWidthsRef.current.get(key) ?? (tileDims.get(key)?.w ?? 16);
      const tileEl = (e.currentTarget as HTMLElement).parentElement;
      if (tileEl) tileEl.setPointerCapture(e.pointerId);
      resizingRef.current = {
        key,
        startX: e.clientX,
        origW: dim,
        el: tileEl,
        currentW: dim,
      };
      wasDraggedRef.current = true; // suppress click actions
      setResizingKey(key);
    },
    [tileDims],
  );

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rz = resizingRef.current;
      if (!rz) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const dx = e.clientX - rz.startX;
      const newW = Math.max(5, Math.min(80, rz.origW + (100 / rect.width) * dx));
      rz.currentW = newW;

      // Direct DOM update
      if (rz.el) {
        rz.el.style.width = `${newW}%`;
      }
    },
    [],
  );

  const handleResizePointerUp = useCallback((e: React.PointerEvent) => {
    const rz = resizingRef.current;
    if (rz) {
      const el = rz.el;
      if (el) {
        try { el.releasePointerCapture(e.pointerId); } catch { /* ok */ }
      }
      const finalW = rz.currentW;
      const key = rz.key;
      resizingRef.current = null;
      setResizingKey(null);
      setCustomWidths((prev) => {
        const next = new Map(prev);
        next.set(key, finalW);
        return next;
      });
      setTimeout(() => { wasDraggedRef.current = false; }, 0);
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
    // Direct DOM update for smooth panning
    const inner = canvasInnerRef.current;
    if (inner) {
      inner.style.transform = `translate(${pan.origOffsetX + dx}px, ${pan.origOffsetY + dy}px)`;
    }
    canvasOffsetRef.current = { x: pan.origOffsetX + dx, y: pan.origOffsetY + dy };
  }, []);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    if (panningRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      // Commit to state once
      setCanvasOffset({ ...canvasOffsetRef.current });
      panningRef.current = null;
      setIsPanning(false);
    }
  }, []);

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
                data-peer={line.peerId}
                data-screen={`screen-${line.peerId}`}
              />
            ))}
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
                />
              ) : key === "screen-local" ? (
                screenStream ? (
                  <ScreenShareTile
                    peerId="local"
                    displayName={localDisplayName || "You"}
                    screenStream={screenStream}
                    streamRevision={streamRevision}
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
  expanded = false,
}: {
  stream: MediaStream | null;
  speaking: boolean;
  hasVideo: boolean;
  displayName?: string;
  avatar?: string;
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
    <div className={`video-tile ${speaking ? "speaking" : ""} ${expanded ? "expanded" : ""}`}>
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
  expanded,
  watching,
  onToggleWatch,
}: {
  peerId: string;
  displayName?: string;
  screenStream: MediaStream;
  streamRevision: number;
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
