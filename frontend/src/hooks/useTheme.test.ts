import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useTheme, { themes, canvasBackgrounds } from "./useTheme";

// Mock localStorage
const store: Record<string, string> = {};
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => store[key] ?? null);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, val) => {
    store[key] = val;
  });
});

describe("useTheme", () => {
  it("returns default theme when no localStorage value", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe("terminal");
  });

  it("restores theme from localStorage", () => {
    store["synced-theme"] = "phosphor";
    const { result } = renderHook(() => useTheme());
    expect(result.current.themeId).toBe("phosphor");
  });

  it("setTheme updates themeId and persists to localStorage", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("cyberpunk"));
    expect(result.current.themeId).toBe("cyberpunk");
    expect(store["synced-theme"]).toBe("cyberpunk");
  });

  it("applies CSS variables to document root on theme change", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("phosphor"));
    const phosphor = themes.find((t) => t.id === "phosphor")!;
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--bg")).toBe(phosphor.vars["--bg"]);
    expect(root.style.getPropertyValue("--text")).toBe(phosphor.vars["--text"]);
  });

  it("toggles scanlines class based on theme", () => {
    const { result } = renderHook(() => useTheme());
    // Terminal has scanlines=true → no-scanlines should be removed
    act(() => result.current.setTheme("terminal"));
    expect(document.body.classList.contains("no-scanlines")).toBe(false);
    // Cyberpunk has scanlines=false → no-scanlines should be added
    act(() => result.current.setTheme("cyberpunk"));
    expect(document.body.classList.contains("no-scanlines")).toBe(true);
  });

  it("exposes all 7 themes", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.themes).toHaveLength(7);
  });
});

describe("useTheme canvas background", () => {
  it("returns default canvas background", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.canvasBgId).toBe("dots");
  });

  it("restores canvas bg from localStorage", () => {
    store["synced-canvas-bg"] = "grid";
    const { result } = renderHook(() => useTheme());
    expect(result.current.canvasBgId).toBe("grid");
  });

  it("setCanvasBg updates and persists", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setCanvasBg("hex"));
    expect(result.current.canvasBgId).toBe("hex");
    expect(store["synced-canvas-bg"]).toBe("hex");
  });

  it("exposes all canvas backgrounds", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.canvasBackgrounds.length).toBe(canvasBackgrounds.length);
    expect(result.current.canvasBackgrounds.length).toBeGreaterThan(0);
  });
});

describe("useTheme UI scale", () => {
  it("returns default scale of 1", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.uiScale).toBe(1);
  });

  it("restores scale from localStorage", () => {
    store["synced-ui-scale"] = "1.25";
    const { result } = renderHook(() => useTheme());
    expect(result.current.uiScale).toBe(1.25);
  });

  it("setUiScale updates and persists", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setUiScale(0.8));
    expect(result.current.uiScale).toBe(0.8);
    expect(store["synced-ui-scale"]).toBe("0.8");
  });

  it("handles invalid stored scale gracefully", () => {
    store["synced-ui-scale"] = "invalid";
    const { result } = renderHook(() => useTheme());
    expect(result.current.uiScale).toBe(1); // falls back to default
  });
});
