import { describe, it, expect, beforeEach } from "vitest";
import { generateUserPalette } from "./colorPalette";

// Mock getComputedStyle to return a known accent color
beforeEach(() => {
  Object.defineProperty(window, "getComputedStyle", {
    value: () => ({
      getPropertyValue: (prop: string) => (prop === "--accent" ? "#3b82f6" : ""),
    }),
    writable: true,
  });
});

describe("generateUserPalette", () => {
  it("returns the correct number of colors", () => {
    expect(generateUserPalette(1)).toHaveLength(1);
    expect(generateUserPalette(4)).toHaveLength(4);
    expect(generateUserPalette(8)).toHaveLength(8);
  });

  it("returns valid hex strings", () => {
    const colors = generateUserPalette(5);
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("returns different colors for count > 1", () => {
    const colors = generateUserPalette(4);
    const unique = new Set(colors);
    expect(unique.size).toBe(4);
  });

  it("returns an empty array for count 0", () => {
    expect(generateUserPalette(0)).toEqual([]);
  });
});
