import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { PeerInfo } from "../hooks/useWebRTC";
import type { PeerAudioState } from "../hooks/useMultiChat";
import AudioVisualizer from "./AudioVisualizer";

/**
 * Generate N evenly-spaced hue-shifted colors from the theme's --accent color.
 * Returns hex strings. Local user gets index 0.
 */
function generateUserPalette(count: number): string[] {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--accent").trim() || "#3b82f6";

  // Parse hex to HSL
  const r = parseInt(accent.slice(1, 3), 16) / 255;
  const g = parseInt(accent.slice(3, 5), 16) / 255;
  const b = parseInt(accent.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  // Boost saturation slightly for better visual distinction
  const baseSat = Math.max(s, 0.5);
  const baseLit = Math.min(Math.max(l, 0.45), 0.65);

  const colors: string[] = [];
  for (let i = 0; i < count; i++) {
    const hue = (h + i / Math.max(count, 1)) % 1;
    // HSL to hex
    const c = (1 - Math.abs(2 * baseLit - 1)) * baseSat;
    const x = c * (1 - Math.abs(((hue * 6) % 2) - 1));
    const m = baseLit - c / 2;
    let r1: number, g1: number, b1: number;
    const seg = Math.floor(hue * 6);
    if (seg === 0) { r1 = c; g1 = x; b1 = 0; }
    else if (seg === 1) { r1 = x; g1 = c; b1 = 0; }
    else if (seg === 2) { r1 = 0; g1 = c; b1 = x; }
    else if (seg === 3) { r1 = 0; g1 = x; b1 = c; }
    else if (seg === 4) { r1 = x; g1 = 0; b1 = c; }
    else { r1 = c; g1 = 0; b1 = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    colors.push(`#${toHex(r1)}${toHex(g1)}${toHex(b1)}`);
  }
  return colors;
}


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
    containerW: number; // cached container dimensions (avoid getBoundingClientRect per frame)
    containerH: number;
    prevX: number; // previous frame position for velocity
    prevY: number;
    velX: number; // velocity in %/frame
    velY: number;
  } | null>(null);
  // Active spring animations for connector rubber-band effect (peerId → animId)
  const springAnimsRef = useRef<Map<string, number>>(new Map());
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
    containerW: number;
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

  /**
   * Clip a line from rect-center A to rect-center B so it starts/ends at
   * the rectangle borders rather than the centers.
   * All values in % of container.
   */
  const clipLineToEdges = useCallback(
    (
      aPos: TilePosition, aDim: TileDim,
      bPos: TilePosition, bDim: TileDim,
    ): { x1: number; y1: number; x2: number; y2: number } | null => {
      const aCx = aPos.x + aDim.w / 2;
      const aH = tileHeightPct(aDim, containerAR);
      const aCy = aPos.y + aH / 2;
      const bCx = bPos.x + bDim.w / 2;
      const bH = tileHeightPct(bDim, containerAR);
      const bCy = bPos.y + bH / 2;

      const dx = bCx - aCx;
      const dy = bCy - aCy;
      if (dx === 0 && dy === 0) return null;

      // Find intersection of ray from center outward with rect edge
      const edgeIntersect = (hw: number, hh: number, rdx: number, rdy: number) => {
        // hw/hh = half-width/half-height of the rect in %
        let t = Infinity;
        if (rdx !== 0) t = Math.min(t, Math.abs(hw / rdx));
        if (rdy !== 0) t = Math.min(t, Math.abs(hh / rdy));
        return t;
      };

      const tA = edgeIntersect(aDim.w / 2, aH / 2, dx, dy);
      const tB = edgeIntersect(bDim.w / 2, bH / 2, -dx, -dy);

      return {
        x1: aCx + dx * tA,
        y1: aCy + dy * tA,
        x2: bCx - dx * tB,
        y2: bCy - dy * tB,
      };
    },
    [containerAR],
  );

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
        const pts = clipLineToEdges(camPos, camDim, screenPos, scrDim);
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
        const pts = clipLineToEdges(camPos, camDim, screenPos, scrDim);
        if (pts) lines.push({ ...pts, peerId: ss.peerId, color: userColors.get(ss.peerId) || "" });
      }
    }
    return lines;
  }, [activeScreenShares, localScreenActive, positions, tileDims, containerAR, clipLineToEdges, userColors]);

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

  // Helper: recompute and update a connector group's SVG paths during drag/resize.
  // `movedKey` is the tile being dragged/resized, `overridePos` is its current position.
  // If `overrideDim` is given (resize), use that for the moved tile's dimensions.
  const updateConnectorLine = useCallback(
    (movedKey: string, overridePos: TilePosition, overrideDim?: TileDim) => {
      const svgContainer = canvasInnerRef.current?.querySelector(".canvas-connectors");
      if (!svgContainer) return;
      const group = svgContainer.querySelector(
        `[data-peer="${movedKey}"], [data-screen="${movedKey}"]`,
      ) as SVGGElement | null;
      if (!group) return;

      // Determine which is the camera key and which is the screen key
      const isCam = group.dataset.peer === movedKey;
      const camKey = isCam ? movedKey : group.dataset.peer!;
      const scrKey = isCam ? group.dataset.screen! : movedKey;

      const camPos = camKey === movedKey ? overridePos : positionsRef.current.get(camKey);
      const scrPos = scrKey === movedKey ? overridePos : positionsRef.current.get(scrKey);
      if (!camPos || !scrPos) return;

      const camDim = (camKey === movedKey && overrideDim) ? overrideDim : (tileDims.get(camKey) ?? DIM_CAMERA);
      const scrDim = (scrKey === movedKey && overrideDim) ? overrideDim : (tileDims.get(scrKey) ?? DIM_SCREEN);

      const pts = clipLineToEdges(camPos, camDim, scrPos, scrDim);
      if (!pts) return;
      const pathD = `M ${pts.x1} ${pts.y1} L ${pts.x2} ${pts.y2}`;

      // Update path in the group
      group.querySelectorAll("path").forEach((p) => p.setAttribute("d", pathD));
    },
    [tileDims, clipLineToEdges],
  );

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

      // Cache container dimensions once on pointerDown (avoids getBoundingClientRect per frame)
      const rect = container.getBoundingClientRect();
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
        containerW: rect.width,
        containerH: rect.height,
        prevX: pos.x,
        prevY: pos.y,
        velX: 0,
        velY: 0,
      };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;

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

      const newX = drag.origX + (100 / drag.containerW) * dx;
      const newY = drag.origY + (100 / drag.containerH) * dy;

      // Track velocity for elastic snap
      drag.velX = newX - drag.prevX;
      drag.velY = newY - drag.prevY;
      drag.prevX = newX;
      drag.prevY = newY;
      drag.currentX = newX;
      drag.currentY = newY;

      // GPU-composited transform for drag — avoids layout reflow (critical for Tauri webview perf)
      if (drag.el) {
        const txPx = (newX - drag.origX) * drag.containerW / 100;
        const tyPx = (newY - drag.origY) * drag.containerH / 100;
        drag.el.style.transform = `translate(${txPx}px, ${tyPx}px)`;
      }

      // Update connector SVG lines directly — recompute edge-clipped endpoints
      updateConnectorLine(drag.key, { x: newX, y: newY });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tileDims, containerAR],
  );

  const startSpringAnim = useCallback((tileKey: string, velX: number, velY: number) => {
    const peerId = tileKey.startsWith("screen-") ? tileKey.replace("screen-", "") : tileKey;
    const camKey = peerId;
    const scrKey = `screen-${peerId}`;

    // Cancel any existing spring for this peer
    const prevAnim = springAnimsRef.current.get(peerId);
    if (prevAnim) cancelAnimationFrame(prevAnim);

    // Compute endpoints from authoritative position/dim state (not DOM)
    const camPos = positionsRef.current.get(camKey);
    const scrPos = positionsRef.current.get(scrKey);
    if (!camPos || !scrPos) return;
    const camDim = tileDims.get(camKey) ?? DIM_CAMERA;
    const scrDim = tileDims.get(scrKey) ?? DIM_SCREEN;
    const pts = clipLineToEdges(camPos, camDim, scrPos, scrDim);
    if (!pts) return;
    const { x1, y1, x2, y2 } = pts;

    // Find the SVG path element to animate
    const svgContainer = canvasInnerRef.current?.querySelector(".canvas-connectors");
    if (!svgContainer) return;
    const group = svgContainer.querySelector(`[data-peer="${peerId}"]`) as SVGGElement | null;
    if (!group) return;
    const pathEl = group.querySelector("path");
    if (!pathEl) return;

    // Compute the perpendicular offset amplitude from velocity
    const speed = Math.sqrt(velX * velX + velY * velY);
    const amplitude = Math.min(speed * 3, 12); // cap at 12 SVG units
    if (amplitude < 0.5) return; // too small, skip

    // Perpendicular direction (normalized in SVG units)
    const ldx = x2 - x1, ldy = y2 - y1;
    const len = Math.sqrt(ldx * ldx + ldy * ldy);
    if (len < 0.1) return;
    // Pick perpendicular side based on velocity cross product
    const cross = velX * ldy - velY * ldx;
    const sign = cross >= 0 ? 1 : -1;
    const perpX = (-ldy / len) * sign;
    const perpY = (ldx / len) * sign;

    // Midpoint of the line (control point base)
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    // Spring physics: damped oscillation
    const decay = 6;     // damping
    const freq = 18;     // oscillation frequency (rad/s)
    const startTime = performance.now();
    const duration = 600; // ms

    const tick = () => {
      const elapsed = (performance.now() - startTime) / 1000; // seconds
      if (elapsed * 1000 > duration) {
        // Settle to straight line
        pathEl.setAttribute("d", `M ${x1} ${y1} L ${x2} ${y2}`);
        springAnimsRef.current.delete(peerId);
        return;
      }
      const offset = amplitude * Math.exp(-decay * elapsed) * Math.sin(freq * elapsed);
      const cx = mx + perpX * offset;
      const cy = my + perpY * offset;
      pathEl.setAttribute("d", `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`);
      springAnimsRef.current.set(peerId, requestAnimationFrame(tick));
    };
    springAnimsRef.current.set(peerId, requestAnimationFrame(tick));
  }, [tileDims, clipLineToEdges]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = draggingRef.current;
    if (drag) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      if (drag.el) {
        drag.el.style.transform = "";
      }
      const finalX = drag.currentX;
      const finalY = drag.currentY;
      const key = drag.key;
      const velX = drag.velX;
      const velY = drag.velY;

      draggingRef.current = null;
      setDraggingKey(null);
      if (wasDraggedRef.current) {
        setPositions((prev) => {
          const next = new Map(prev);
          next.set(key, { x: finalX, y: finalY });
          return next;
        });
        // Launch spring animation after React re-render commits new positions
        requestAnimationFrame(() => startSpringAnim(key, velX, velY));
        setTimeout(() => { wasDraggedRef.current = false; }, 0);
      }
    }
  }, [startSpringAnim]);

  // --- Resize handlers ---
  // Same direct-DOM-manipulation pattern as drag for performance.
  // Only width changes; aspect ratio is locked via CSS aspectRatio.
  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, key: string) => {
      e.stopPropagation(); // prevent drag from starting
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const dim = customWidthsRef.current.get(key) ?? (tileDims.get(key)?.w ?? 16);
      const tileEl = (e.currentTarget as HTMLElement).parentElement;
      if (tileEl) tileEl.setPointerCapture(e.pointerId);
      resizingRef.current = {
        key,
        startX: e.clientX,
        origW: dim,
        el: tileEl,
        currentW: dim,
        containerW: rect.width,
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

      const dx = e.clientX - rz.startX;
      const newW = Math.max(5, Math.min(80, rz.origW + (100 / rz.containerW) * dx));
      rz.currentW = newW;

      // GPU-composited scale during resize — avoids layout reflow
      if (rz.el) {
        const scale = newW / rz.origW;
        rz.el.style.transform = `scale(${scale})`;
        rz.el.style.transformOrigin = "top left";
      }

      // Update connector line with the new effective dimensions
      const baseDim = tileDims.get(rz.key);
      if (baseDim) {
        const pos = positionsRef.current.get(rz.key);
        if (pos) updateConnectorLine(rz.key, pos, { w: newW, aspect: baseDim.aspect });
      }

    },
    [tileDims, updateConnectorLine],
  );

  const handleResizePointerUp = useCallback((e: React.PointerEvent) => {
    const rz = resizingRef.current;
    if (rz) {
      const el = rz.el;
      if (el) {
        try { el.releasePointerCapture(e.pointerId); } catch { /* ok */ }
        el.style.transform = "";
        el.style.transformOrigin = "";
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
