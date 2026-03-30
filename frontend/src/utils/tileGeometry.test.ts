import { describe, it, expect } from "vitest";
import {
  tileHeightPct,
  rectsOverlap,
  findNearestEmpty,
  computeDefaultPositions,
  clipLineToEdges,
  DIM_AUDIO,
  DIM_CAMERA,
  DIM_SCREEN,
} from "./tileGeometry";

describe("tileHeightPct", () => {
  it("returns correct height percentage for a square tile with 16:9 container", () => {
    // DIM_AUDIO: w=10, aspect=1; containerAR=16/9
    // height% = 10 * (16/9) / 1 ≈ 17.78
    const h = tileHeightPct(DIM_AUDIO, 16 / 9);
    expect(h).toBeCloseTo(17.78, 1);
  });

  it("returns correct height for camera tile", () => {
    // DIM_CAMERA: w=16, aspect=4/3; containerAR=16/9
    // height% = 16 * (16/9) / (4/3) = 16 * 1.778 / 1.333 ≈ 21.33
    const h = tileHeightPct(DIM_CAMERA, 16 / 9);
    expect(h).toBeCloseTo(21.33, 1);
  });

  it("scales with container aspect ratio", () => {
    const h1 = tileHeightPct(DIM_CAMERA, 1); // square container
    const h2 = tileHeightPct(DIM_CAMERA, 2); // wide container
    expect(h2).toBe(h1 * 2);
  });
});

describe("rectsOverlap", () => {
  const ar = 16 / 9;

  it("detects overlapping rectangles", () => {
    const a = { x: 10, y: 10 };
    const b = { x: 15, y: 15 };
    expect(rectsOverlap(a, DIM_CAMERA, b, DIM_CAMERA, ar)).toBe(true);
  });

  it("detects non-overlapping rectangles", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 50, y: 50 };
    expect(rectsOverlap(a, DIM_AUDIO, b, DIM_AUDIO, ar)).toBe(false);
  });

  it("respects margin parameter", () => {
    const a = { x: 0, y: 0 };
    // Place b just outside a's width (10) with no margin
    const b = { x: DIM_AUDIO.w + 1, y: 0 };
    expect(rectsOverlap(a, DIM_AUDIO, b, DIM_AUDIO, ar, 0)).toBe(false);
    // With a large margin they should overlap
    expect(rectsOverlap(a, DIM_AUDIO, b, DIM_AUDIO, ar, 5)).toBe(true);
  });
});

describe("findNearestEmpty", () => {
  const ar = 16 / 9;

  it("returns target when no tiles are occupied", () => {
    const pos = findNearestEmpty({ x: 20, y: 20 }, DIM_CAMERA, [], ar);
    expect(pos).toEqual({ x: 20, y: 20 });
  });

  it("avoids occupied positions", () => {
    const occupied = [{ pos: { x: 20, y: 20 }, dim: DIM_CAMERA }];
    const pos = findNearestEmpty({ x: 20, y: 20 }, DIM_CAMERA, occupied, ar);
    // Should not be at the occupied position
    expect(pos.x !== 20 || pos.y !== 20).toBe(true);
  });
});

describe("computeDefaultPositions", () => {
  const ar = 16 / 9;
  const getDim = () => DIM_CAMERA;

  it("returns empty map for no tiles", () => {
    const result = computeDefaultPositions([], getDim, ar);
    expect(result.size).toBe(0);
  });

  it("positions all tiles", () => {
    const keys = ["a", "b", "c", "d"];
    const result = computeDefaultPositions(keys, getDim, ar);
    expect(result.size).toBe(4);
    for (const key of keys) {
      expect(result.has(key)).toBe(true);
    }
  });

  it("distributes tiles in a grid", () => {
    const keys = ["a", "b", "c", "d"];
    const result = computeDefaultPositions(keys, getDim, ar);
    // 4 tiles → 2x2 grid; positions should differ
    const positions = [...result.values()];
    const uniqueX = new Set(positions.map((p) => p.x));
    const uniqueY = new Set(positions.map((p) => p.y));
    expect(uniqueX.size).toBe(2);
    expect(uniqueY.size).toBe(2);
  });
});

describe("clipLineToEdges", () => {
  const ar = 16 / 9;

  it("returns null when positions are identical", () => {
    const pos = { x: 10, y: 10 };
    expect(clipLineToEdges(pos, DIM_CAMERA, pos, DIM_CAMERA, ar)).toBeNull();
  });

  it("returns clipped endpoints for separated tiles", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 50, y: 50 };
    const result = clipLineToEdges(a, DIM_CAMERA, b, DIM_SCREEN, ar);
    expect(result).not.toBeNull();
    // Start should be outside tile A center, end outside tile B center
    const aCx = a.x + DIM_CAMERA.w / 2;
    const bCx = b.x + DIM_SCREEN.w / 2;
    expect(result!.x1).toBeGreaterThan(aCx);
    expect(result!.x2).toBeLessThan(bCx);
  });
});
