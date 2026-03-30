/**
 * Hook encapsulating drag, resize, pan, and spring animation logic
 * for the spatial video canvas in VideoGrid.
 *
 * Separates pointer interaction from rendering/layout concerns.
 * Uses direct DOM manipulation during drag/resize for performance
 * and only commits to React state on pointer-up.
 */
import { useRef, useState, useCallback } from "react";
import type { TilePosition, TileDim } from "../utils/tileGeometry";
import { clipLineToEdges, DIM_CAMERA, DIM_SCREEN, DRAG_THRESHOLD } from "../utils/tileGeometry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DragState {
  key: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  el: HTMLElement | null;
  currentX: number;
  currentY: number;
  containerW: number;
  containerH: number;
  prevX: number;
  prevY: number;
  velX: number;
  velY: number;
}

interface ResizeState {
  key: string;
  startX: number;
  origW: number;
  el: HTMLElement | null;
  currentW: number;
  containerW: number;
}

interface PanState {
  startX: number;
  startY: number;
  origOffsetX: number;
  origOffsetY: number;
}

export interface SpatialInteractionOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasInnerRef: React.RefObject<HTMLDivElement | null>;
  positionsRef: React.MutableRefObject<Map<string, TilePosition>>;
  tileDims: Map<string, TileDim>;
  containerAR: number;
  setPositions: React.Dispatch<React.SetStateAction<Map<string, TilePosition>>>;
  setCustomWidths: React.Dispatch<React.SetStateAction<Map<string, number>>>;
}

export interface SpatialInteractionResult {
  draggingKey: string | null;
  resizingKey: string | null;
  isPanning: boolean;
  canvasOffset: { x: number; y: number };
  wasDraggedRef: React.MutableRefObject<boolean>;
  // Drag handlers — attach to individual tiles
  handlePointerDown: (e: React.PointerEvent, key: string) => void;
  handlePointerMove: (e: React.PointerEvent) => void;
  handlePointerUp: (e: React.PointerEvent) => void;
  // Resize handlers — attach to resize handles on tiles
  handleResizePointerDown: (e: React.PointerEvent, key: string) => void;
  handleResizePointerMove: (e: React.PointerEvent) => void;
  handleResizePointerUp: (e: React.PointerEvent) => void;
  // Canvas pan handlers — attach to the canvas container (middle-click)
  handleCanvasPointerDown: (e: React.PointerEvent) => void;
  handleCanvasPointerMove: (e: React.PointerEvent) => void;
  handleCanvasPointerUp: (e: React.PointerEvent) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useSpatialInteraction({
  containerRef,
  canvasInnerRef,
  positionsRef,
  tileDims,
  containerAR,
  setPositions,
  setCustomWidths,
}: SpatialInteractionOptions): SpatialInteractionResult {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // Refs for interaction state (avoids stale closures in pointer handlers)
  const draggingRef = useRef<DragState | null>(null);
  const resizingRef = useRef<ResizeState | null>(null);
  const panningRef = useRef<PanState | null>(null);
  const springAnimsRef = useRef<Map<string, number>>(new Map());
  const wasDraggedRef = useRef(false);
  const canvasOffsetRef = useRef(canvasOffset);
  canvasOffsetRef.current = canvasOffset;
  // Ref copies of deps used in pointer handlers to avoid stale closures
  const tileDimsRef = useRef(tileDims);
  tileDimsRef.current = tileDims;
  const containerARRef = useRef(containerAR);
  containerARRef.current = containerAR;

  // Helper: update connector SVG lines during drag/resize
  const updateConnectorLine = useCallback(
    (movedKey: string, overridePos: TilePosition, overrideDim?: TileDim) => {
      const svgContainer = canvasInnerRef.current?.querySelector(".canvas-connectors");
      if (!svgContainer) return;
      const group = svgContainer.querySelector(
        `[data-peer="${movedKey}"], [data-screen="${movedKey}"]`,
      ) as SVGGElement | null;
      if (!group) return;

      const isCam = group.dataset.peer === movedKey;
      const camKey = isCam ? movedKey : group.dataset.peer!;
      const scrKey = isCam ? group.dataset.screen! : movedKey;

      const camPos = camKey === movedKey ? overridePos : positionsRef.current.get(camKey);
      const scrPos = scrKey === movedKey ? overridePos : positionsRef.current.get(scrKey);
      if (!camPos || !scrPos) return;

      const dims = tileDimsRef.current;
      const camDim = (camKey === movedKey && overrideDim) ? overrideDim : (dims.get(camKey) ?? DIM_CAMERA);
      const scrDim = (scrKey === movedKey && overrideDim) ? overrideDim : (dims.get(scrKey) ?? DIM_SCREEN);

      const pts = clipLineToEdges(camPos, camDim, scrPos, scrDim, containerARRef.current);
      if (!pts) return;
      const pathD = `M ${pts.x1} ${pts.y1} L ${pts.x2} ${pts.y2}`;
      group.querySelectorAll("path").forEach((p) => p.setAttribute("d", pathD));
    },
    [canvasInnerRef, positionsRef],
  );

  // Spring animation for connector rubber-band effect
  const startSpringAnim = useCallback((tileKey: string, velX: number, velY: number) => {
    const peerId = tileKey.startsWith("screen-") ? tileKey.replace("screen-", "") : tileKey;
    const camKey = peerId;
    const scrKey = `screen-${peerId}`;

    const prevAnim = springAnimsRef.current.get(peerId);
    if (prevAnim) cancelAnimationFrame(prevAnim);

    const dims = tileDimsRef.current;
    const ar = containerARRef.current;
    const camPos = positionsRef.current.get(camKey);
    const scrPos = positionsRef.current.get(scrKey);
    if (!camPos || !scrPos) return;
    const camDim = dims.get(camKey) ?? DIM_CAMERA;
    const scrDim = dims.get(scrKey) ?? DIM_SCREEN;
    const pts = clipLineToEdges(camPos, camDim, scrPos, scrDim, ar);
    if (!pts) return;
    const { x1, y1, x2, y2 } = pts;

    const svgContainer = canvasInnerRef.current?.querySelector(".canvas-connectors");
    if (!svgContainer) return;
    const group = svgContainer.querySelector(`[data-peer="${peerId}"]`) as SVGGElement | null;
    if (!group) return;
    const pathEl = group.querySelector("path");
    if (!pathEl) return;

    const speed = Math.sqrt(velX * velX + velY * velY);
    const amplitude = Math.min(speed * 3, 12);
    if (amplitude < 0.5) return;

    const ldx = x2 - x1, ldy = y2 - y1;
    const len = Math.sqrt(ldx * ldx + ldy * ldy);
    if (len < 0.1) return;
    const cross = velX * ldy - velY * ldx;
    const sign = cross >= 0 ? 1 : -1;
    const perpX = (-ldy / len) * sign;
    const perpY = (ldx / len) * sign;

    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    const decay = 6;
    const freq = 18;
    const startTime = performance.now();
    const duration = 600;

    const tick = () => {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed * 1000 > duration) {
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
  }, [canvasInnerRef, positionsRef]);

  // --- Drag handlers ---
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, key: string) => {
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      const pos = positionsRef.current.get(key);
      if (!pos) return;

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
    [containerRef, positionsRef],
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

      drag.velX = newX - drag.prevX;
      drag.velY = newY - drag.prevY;
      drag.prevX = newX;
      drag.prevY = newY;
      drag.currentX = newX;
      drag.currentY = newY;

      if (drag.el) {
        const txPx = (newX - drag.origX) * drag.containerW / 100;
        const tyPx = (newY - drag.origY) * drag.containerH / 100;
        drag.el.style.transform = `translate(${txPx}px, ${tyPx}px)`;
      }

      updateConnectorLine(drag.key, { x: newX, y: newY });
    },
    [updateConnectorLine],
  );

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
        requestAnimationFrame(() => startSpringAnim(key, velX, velY));
        setTimeout(() => { wasDraggedRef.current = false; }, 0);
      }
    }
  }, [startSpringAnim, setPositions]);

  // --- Resize handlers ---
  const handleResizePointerDown = useCallback(
    (e: React.PointerEvent, key: string) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const dims = tileDimsRef.current;
      const dim = dims.get(key)?.w ?? 16;
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
      wasDraggedRef.current = true;
      setResizingKey(key);
    },
    [containerRef],
  );

  const handleResizePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rz = resizingRef.current;
      if (!rz) return;

      const dx = e.clientX - rz.startX;
      const newW = Math.max(5, Math.min(80, rz.origW + (100 / rz.containerW) * dx));
      rz.currentW = newW;

      if (rz.el) {
        const scale = newW / rz.origW;
        rz.el.style.transform = `scale(${scale})`;
        rz.el.style.transformOrigin = "top left";
      }

      const dims = tileDimsRef.current;
      const baseDim = dims.get(rz.key);
      if (baseDim) {
        const pos = positionsRef.current.get(rz.key);
        if (pos) updateConnectorLine(rz.key, pos, { w: newW, aspect: baseDim.aspect });
      }
    },
    [positionsRef, updateConnectorLine],
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
  }, [setCustomWidths]);

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
    const inner = canvasInnerRef.current;
    if (inner) {
      inner.style.transform = `translate(${pan.origOffsetX + dx}px, ${pan.origOffsetY + dy}px)`;
    }
    canvasOffsetRef.current = { x: pan.origOffsetX + dx, y: pan.origOffsetY + dy };
  }, [canvasInnerRef]);

  const handleCanvasPointerUp = useCallback((e: React.PointerEvent) => {
    if (panningRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      setCanvasOffset({ ...canvasOffsetRef.current });
      panningRef.current = null;
      setIsPanning(false);
    }
  }, []);

  return {
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
  };
}
