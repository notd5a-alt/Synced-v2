import { themes, canvasBackgrounds, scaleOptions } from "../hooks/useTheme";

interface ThemeSelectorProps {
  currentTheme: string;
  onSelect: (id: string) => void;
  currentCanvasBg: string;
  onCanvasBgSelect: (id: string) => void;
  currentScale: number;
  onScaleSelect: (scale: number) => void;
}

export default function ThemeSelector({
  currentTheme,
  onSelect,
  currentCanvasBg,
  onCanvasBgSelect,
  currentScale,
  onScaleSelect,
}: ThemeSelectorProps) {
  return (
    <div className="theme-selector">
      <div className="style-section">
        <span className="theme-label">SCALE</span>
        <div className="theme-options">
          {scaleOptions.map((opt) => (
            <button
              key={opt.value}
              className={`theme-swatch scale-swatch ${currentScale === opt.value ? "active" : ""}`}
              onClick={() => onScaleSelect(opt.value)}
              title={opt.label}
            >
              <span className="swatch-name">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="style-section">
        <span className="theme-label">THEME</span>
        <div className="theme-options">
          {themes.map((t) => (
            <button
              key={t.id}
              className={`theme-swatch ${currentTheme === t.id ? "active" : ""}`}
              onClick={() => onSelect(t.id)}
              title={t.name}
            >
              <span
                className="swatch-color"
                style={{
                  background: t.vars["--bg"],
                  borderColor: t.vars["--text"],
                  color: t.vars["--text"],
                }}
              />
              <span className="swatch-name">{t.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="style-section">
        <span className="theme-label">CANVAS</span>
        <div className="theme-options">
          {canvasBackgrounds.map((bg) => (
            <button
              key={bg.id}
              className={`theme-swatch canvas-bg-swatch ${currentCanvasBg === bg.id ? "active" : ""}`}
              onClick={() => onCanvasBgSelect(bg.id)}
              title={bg.name}
            >
              <span
                className="swatch-color canvas-bg-preview"
                style={{
                  background: "var(--surface, #131313)",
                  backgroundImage: bg.css.backgroundImage,
                  backgroundSize: bg.css.backgroundSize,
                  backgroundPosition: bg.css.backgroundPosition,
                  borderColor: "var(--outline)",
                }}
              />
              <span className="swatch-name">{bg.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
