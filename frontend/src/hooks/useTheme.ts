import { useState, useEffect, useCallback } from "react";

export interface ThemeDefinition {
  id: string;
  name: string;
  vars: Record<string, string>;
  scanlines?: boolean;
}

export const themes: ThemeDefinition[] = [
  {
    id: "terminal",
    name: "Terminal",
    scanlines: true,
    vars: {
      "--bg": "#000000",
      "--surface": "#131313",
      "--surface-low": "#1b1b1b",
      "--surface-highest": "#353535",
      "--surface-bright": "#393939",
      "--outline": "#474747",
      "--text": "#FFFFFF",
      "--text-dim": "rgba(255, 255, 255, 0.5)",
      "--error": "#ffb4ab",
      "--ghost-border": "rgba(71, 71, 71, 0.2)",
      "--accent": "#3b82f6",
      "--success": "#4ade80",
      "--canvas-dot": "rgba(255, 255, 255, 0.08)",
    },
  },
  {
    id: "phosphor",
    name: "Phosphor",
    scanlines: true,
    vars: {
      "--bg": "#0a0e0a",
      "--surface": "#0f160f",
      "--surface-low": "#121a12",
      "--surface-highest": "#1e2e1e",
      "--surface-bright": "#253525",
      "--outline": "#2a3f2a",
      "--text": "#33ff33",
      "--text-dim": "rgba(51, 255, 51, 0.45)",
      "--error": "#ff4444",
      "--ghost-border": "rgba(51, 255, 51, 0.1)",
      "--accent": "#66ff66",
      "--success": "#33ff33",
      "--canvas-dot": "rgba(51, 255, 51, 0.08)",
    },
  },
  {
    id: "amber",
    name: "Amber",
    scanlines: true,
    vars: {
      "--bg": "#0e0a00",
      "--surface": "#161000",
      "--surface-low": "#1a1400",
      "--surface-highest": "#2e2400",
      "--surface-bright": "#352a00",
      "--outline": "#3f3200",
      "--text": "#ffb000",
      "--text-dim": "rgba(255, 176, 0, 0.45)",
      "--error": "#ff4444",
      "--ghost-border": "rgba(255, 176, 0, 0.1)",
      "--accent": "#ffc233",
      "--success": "#ffb000",
      "--canvas-dot": "rgba(255, 176, 0, 0.08)",
    },
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    scanlines: false,
    vars: {
      "--bg": "#0a0014",
      "--surface": "#12001f",
      "--surface-low": "#180028",
      "--surface-highest": "#2a0045",
      "--surface-bright": "#350055",
      "--outline": "#4a0070",
      "--text": "#e0e0ff",
      "--text-dim": "rgba(224, 224, 255, 0.5)",
      "--error": "#ff2060",
      "--ghost-border": "rgba(180, 0, 255, 0.15)",
      "--accent": "#b400ff",
      "--success": "#00ff88",
      "--canvas-dot": "rgba(180, 0, 255, 0.1)",
    },
  },
  {
    id: "arctic",
    name: "Arctic",
    scanlines: false,
    vars: {
      "--bg": "#0b1622",
      "--surface": "#0f1d2e",
      "--surface-low": "#132438",
      "--surface-highest": "#1e3a54",
      "--surface-bright": "#244560",
      "--outline": "#2d5577",
      "--text": "#d4e8ff",
      "--text-dim": "rgba(212, 232, 255, 0.5)",
      "--error": "#ff6b6b",
      "--ghost-border": "rgba(100, 180, 255, 0.12)",
      "--accent": "#64b5f6",
      "--success": "#4ade80",
      "--canvas-dot": "rgba(100, 180, 255, 0.1)",
    },
  },
  {
    id: "blood",
    name: "Blood",
    scanlines: false,
    vars: {
      "--bg": "#0e0000",
      "--surface": "#1a0505",
      "--surface-low": "#200808",
      "--surface-highest": "#3a1010",
      "--surface-bright": "#451515",
      "--outline": "#551a1a",
      "--text": "#ffcccc",
      "--text-dim": "rgba(255, 204, 204, 0.5)",
      "--error": "#ff4040",
      "--ghost-border": "rgba(255, 50, 50, 0.12)",
      "--accent": "#ff4040",
      "--success": "#ff8080",
      "--canvas-dot": "rgba(255, 50, 50, 0.08)",
    },
  },
  {
    id: "snow",
    name: "Snow",
    scanlines: false,
    vars: {
      "--bg": "#f0f0f0",
      "--surface": "#ffffff",
      "--surface-low": "#e8e8e8",
      "--surface-highest": "#d0d0d0",
      "--surface-bright": "#c8c8c8",
      "--outline": "#aaaaaa",
      "--text": "#1a1a1a",
      "--text-dim": "rgba(26, 26, 26, 0.5)",
      "--tile-border": "rgba(0, 0, 0, 0.25)",
      "--error": "#cc0000",
      "--ghost-border": "rgba(0, 0, 0, 0.1)",
      "--accent": "#2563eb",
      "--success": "#16a34a",
      "--canvas-dot": "rgba(0, 0, 0, 0.1)",
    },
  },
];

// --- Canvas background patterns ---

export interface CanvasBackground {
  id: string;
  name: string;
  css: {
    backgroundImage: string;
    backgroundSize: string;
    backgroundPosition?: string;
  };
  /** Optional CSS class added to .video-canvas for animated/complex patterns */
  className?: string;
}

export const canvasBackgrounds: CanvasBackground[] = [
  {
    id: "dots",
    name: "Dots",
    css: {
      backgroundImage: "radial-gradient(circle, var(--canvas-dot, rgba(255,255,255,0.08)) 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    },
  },
  {
    id: "grid",
    name: "Grid",
    css: {
      backgroundImage:
        "linear-gradient(var(--canvas-dot, rgba(255,255,255,0.06)) 1px, transparent 1px), linear-gradient(90deg, var(--canvas-dot, rgba(255,255,255,0.06)) 1px, transparent 1px)",
      backgroundSize: "32px 32px",
    },
  },
  {
    id: "cross",
    name: "Cross",
    css: {
      backgroundImage:
        "radial-gradient(circle, var(--canvas-dot, rgba(255,255,255,0.08)) 1px, transparent 1px), linear-gradient(var(--canvas-dot, rgba(255,255,255,0.04)) 1px, transparent 1px), linear-gradient(90deg, var(--canvas-dot, rgba(255,255,255,0.04)) 1px, transparent 1px)",
      backgroundSize: "32px 32px, 32px 32px, 32px 32px",
    },
  },
  {
    id: "isometric",
    name: "Iso",
    css: {
      backgroundImage:
        "linear-gradient(30deg, var(--canvas-dot, rgba(255,255,255,0.05)) 12%, transparent 12.5%, transparent 87%, var(--canvas-dot, rgba(255,255,255,0.05)) 87.5%), linear-gradient(150deg, var(--canvas-dot, rgba(255,255,255,0.05)) 12%, transparent 12.5%, transparent 87%, var(--canvas-dot, rgba(255,255,255,0.05)) 87.5%), linear-gradient(30deg, var(--canvas-dot, rgba(255,255,255,0.05)) 12%, transparent 12.5%, transparent 87%, var(--canvas-dot, rgba(255,255,255,0.05)) 87.5%), linear-gradient(150deg, var(--canvas-dot, rgba(255,255,255,0.05)) 12%, transparent 12.5%, transparent 87%, var(--canvas-dot, rgba(255,255,255,0.05)) 87.5%)",
      backgroundSize: "40px 70px",
      backgroundPosition: "0 0, 0 0, 20px 35px, 20px 35px",
    },
  },
  {
    id: "hex",
    name: "Hex",
    css: {
      backgroundImage:
        "radial-gradient(circle, var(--canvas-dot, rgba(255,255,255,0.07)) 1.5px, transparent 1.5px), radial-gradient(circle, var(--canvas-dot, rgba(255,255,255,0.07)) 1.5px, transparent 1.5px)",
      backgroundSize: "40px 69px",
      backgroundPosition: "0 0, 20px 34.5px",
    },
  },
  {
    id: "diagonal",
    name: "Diagonal",
    css: {
      backgroundImage:
        "repeating-linear-gradient(45deg, transparent, transparent 14px, var(--canvas-dot, rgba(255,255,255,0.04)) 14px, var(--canvas-dot, rgba(255,255,255,0.04)) 15px)",
      backgroundSize: "auto",
    },
  },
  {
    id: "dense-dots",
    name: "Dense",
    css: {
      backgroundImage: "radial-gradient(circle, var(--canvas-dot, rgba(255,255,255,0.08)) 1px, transparent 1px)",
      backgroundSize: "12px 12px",
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    css: {
      backgroundImage:
        "linear-gradient(var(--canvas-dot, rgba(255,255,255,0.04)) 1px, transparent 1px), linear-gradient(90deg, var(--canvas-dot, rgba(255,255,255,0.04)) 1px, transparent 1px), linear-gradient(var(--canvas-dot, rgba(255,255,255,0.02)) 1px, transparent 1px), linear-gradient(90deg, var(--canvas-dot, rgba(255,255,255,0.02)) 1px, transparent 1px)",
      backgroundSize: "64px 64px, 64px 64px, 16px 16px, 16px 16px",
    },
  },
  {
    id: "weave",
    name: "Weave",
    css: {
      backgroundImage: [
        "repeating-linear-gradient(45deg, #0000 calc(-650% / 13) calc(50% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(100% / 13), #0000 0 calc(150% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(200% / 13), #0000 0 calc(250% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(300% / 13))",
        "repeating-linear-gradient(45deg, #0000 calc(-650% / 13) calc(50% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(100% / 13), #0000 0 calc(150% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(200% / 13), #0000 0 calc(250% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(300% / 13))",
        "repeating-linear-gradient(-45deg, #0000 calc(-650% / 13) calc(50% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(100% / 13), #0000 0 calc(150% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(200% / 13), #0000 0 calc(250% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(300% / 13))",
        "repeating-linear-gradient(-45deg, #0000 calc(-650% / 13) calc(50% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(100% / 13), #0000 0 calc(150% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(200% / 13), #0000 0 calc(250% / 13), var(--canvas-dot, rgba(255,255,255,0.06)) 0 calc(300% / 13))",
      ].join(", "),
      backgroundSize: "64px 64px",
      backgroundPosition: "0px 0px, 32px 32px, 0px 0px, 32px 32px",
    },
  },
  {
    id: "shadow",
    name: "Shadow",
    css: {
      backgroundImage:
        "linear-gradient(32deg, var(--canvas-dot, rgba(255,255,255,0.06)) 30px, transparent 30px)",
      backgroundSize: "60px 60px",
      backgroundPosition: "-5px -5px",
    },
  },
  {
    id: "rain",
    name: "Rain",
    className: "canvas-bg-rain",
    css: {
      backgroundImage: "none",
      backgroundSize: "auto",
    },
  },
  {
    id: "none",
    name: "None",
    css: {
      backgroundImage: "none",
      backgroundSize: "auto",
    },
  },
];

const STORAGE_KEY = "synced-theme";
const CANVAS_BG_KEY = "synced-canvas-bg";
const SCALE_KEY = "synced-ui-scale";
const DEFAULT_THEME = "terminal";
const DEFAULT_CANVAS_BG = "dots";
const DEFAULT_SCALE = 1;

export const scaleOptions = [
  { value: 0.8, label: "80%" },
  { value: 0.9, label: "90%" },
  { value: 1, label: "100%" },
  { value: 1.1, label: "110%" },
  { value: 1.25, label: "125%" },
];

function applyTheme(theme: ThemeDefinition) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  // Toggle scanlines
  document.body.classList.toggle("no-scanlines", !theme.scanlines);
}

export default function useTheme() {
  const [themeId, setThemeId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  });

  const [canvasBgId, setCanvasBgId] = useState<string>(() => {
    try {
      return localStorage.getItem(CANVAS_BG_KEY) || DEFAULT_CANVAS_BG;
    } catch {
      return DEFAULT_CANVAS_BG;
    }
  });

  const [uiScale, setUiScaleState] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(SCALE_KEY);
      return stored ? parseFloat(stored) || DEFAULT_SCALE : DEFAULT_SCALE;
    } catch {
      return DEFAULT_SCALE;
    }
  });

  useEffect(() => {
    const theme = themes.find((t) => t.id === themeId) || themes[0];
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, themeId);
    } catch {
      // storage full or blocked
    }
  }, [themeId]);

  useEffect(() => {
    const bg = canvasBackgrounds.find((b) => b.id === canvasBgId) || canvasBackgrounds[0];
    const root = document.documentElement;
    root.style.setProperty("--canvas-bg-image", bg.css.backgroundImage);
    root.style.setProperty("--canvas-bg-size", bg.css.backgroundSize);
    root.style.setProperty("--canvas-bg-position", bg.css.backgroundPosition || "0 0");
    // Toggle pattern-specific CSS classes (e.g. animated backgrounds)
    for (const b of canvasBackgrounds) {
      if (b.className) root.classList.toggle(b.className, b.id === canvasBgId);
    }
    try {
      localStorage.setItem(CANVAS_BG_KEY, canvasBgId);
    } catch {
      // storage full or blocked
    }
  }, [canvasBgId]);

  useEffect(() => {
    document.documentElement.style.zoom = String(uiScale);
    try {
      localStorage.setItem(SCALE_KEY, String(uiScale));
    } catch {
      // storage full or blocked
    }
  }, [uiScale]);

  const setTheme = useCallback((id: string) => {
    setThemeId(id);
  }, []);

  const setCanvasBg = useCallback((id: string) => {
    setCanvasBgId(id);
  }, []);

  const setUiScale = useCallback((scale: number) => {
    setUiScaleState(scale);
  }, []);

  return { themeId, setTheme, themes, canvasBgId, setCanvasBg, canvasBackgrounds, uiScale, setUiScale };
}
