/**
 * Pure geometry utilities for the spatial video canvas.
 * No React dependencies — functions operate on plain data structures.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface TilePosition {
  x: number; // percentage of container width
  y: number; // percentage of container height
}

/** Tile dimensions: w = % of container width, aspect = width/height ratio */
export interface TileDim {
  w: number;
  aspect: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const DIM_AUDIO: TileDim = { w: 10, aspect: 1 };       // audio-only peers (small square)
export const DIM_CAMERA: TileDim = { w: 16, aspect: 4 / 3 };  // camera tiles (4:3)
export const DIM_SCREEN: TileDim = { w: 28, aspect: 16 / 9 }; // screen share tiles (16:9)

export const DRAG_THRESHOLD = 3; // px — movement below this is a click, not a drag

// ---------------------------------------------------------------------------
// Geometry functions
// ---------------------------------------------------------------------------

/** Convert tile dim to height-% given the container aspect ratio. */
export function tileHeightPct(dim: TileDim, containerAR: number): number {
  // width is % of container width; height in px = (w% * cW) / aspect
  // height as % of container height = height_px / cH * 100
  //   = (w * cW / 100 / aspect) / cH * 100
  //   = w * (cW / cH) / aspect
  //   = w * containerAR / aspect
  return dim.w * containerAR / dim.aspect;
}

/** Check if two rectangles overlap (positions in %, sizes via TileDim). */
export function rectsOverlap(
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
export function findNearestEmpty(
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
export function computeDefaultPositions(
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
 * Clip a line from rect-center A to rect-center B so it starts/ends at
 * the rectangle borders rather than the centers.
 * All values in % of container.
 */
export function clipLineToEdges(
  aPos: TilePosition, aDim: TileDim,
  bPos: TilePosition, bDim: TileDim,
  containerAR: number,
): { x1: number; y1: number; x2: number; y2: number } | null {
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
}
