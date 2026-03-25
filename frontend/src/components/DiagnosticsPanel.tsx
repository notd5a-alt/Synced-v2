import { useState, useEffect, useRef } from "react";
import type { ConnectionStats, ConnectionQuality, ConnectionType } from "../types";

const MAX_HISTORY = 30;
const BARS = "▁▂▃▄▅▆▇█";
const GRAPH_ROWS = 5;

interface HistoryEntry extends ConnectionStats {
  ts: number;
}

function asciiGraph(label: string, unit: string, values: number[], maxScale: number | "auto"): string {
  if (values.length === 0) return `${label} (${unit})\n  No data yet`;

  const max = maxScale === "auto"
    ? Math.max(...values, 1)
    : maxScale;
  const levels = GRAPH_ROWS * BARS.length;

  // Pad to MAX_HISTORY columns
  const padded = Array(MAX_HISTORY - values.length).fill(0).concat(values) as number[];

  // Build rows top-down
  const rows: string[] = [];
  for (let row = GRAPH_ROWS - 1; row >= 0; row--) {
    const yVal = ((row + 1) / GRAPH_ROWS) * max;
    const yLabel = yVal >= 1000
      ? `${(yVal / 1000).toFixed(1)}k`
      : yVal >= 100
      ? Math.round(yVal).toString()
      : yVal.toFixed(1);
    let line = yLabel.padStart(5) + "│";

    for (let col = 0; col < MAX_HISTORY; col++) {
      const v = padded[col];
      const normalized = Math.min(v / max, 1) * levels;
      const barInRow = normalized - row * BARS.length;
      if (barInRow >= BARS.length) {
        line += BARS[BARS.length - 1];
      } else if (barInRow > 0) {
        line += BARS[Math.floor(barInRow)];
      } else {
        line += " ";
      }
    }
    rows.push(line);
  }

  // Bottom axis
  rows.push("    0│" + "─".repeat(MAX_HISTORY));

  return `  ${label} (${unit})\n${rows.join("\n")}`;
}

interface DiagnosticsPanelProps {
  stats: ConnectionStats | null;
  connectionQuality: ConnectionQuality | null;
  connectionType: ConnectionType | null;
}

export default function DiagnosticsPanel({ stats, connectionQuality, connectionType }: DiagnosticsPanelProps) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const prevStatsRef = useRef<ConnectionStats | null>(null);

  useEffect(() => {
    if (!stats || !stats.rtt) return;
    // Only push if stats actually changed (avoid duplicates)
    if (prevStatsRef.current === stats) return;
    prevStatsRef.current = stats;
    setHistory((prev) => {
      const next = [...prev, { ...stats, ts: Date.now() }];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
  }, [stats]);

  const rttValues = history.map((h) => h.rtt ?? 0);
  const lossValues = history.map((h) => h.packetLoss ?? 0);
  const bitrateValues = history.map((h) => (h.bitrate ?? 0) / 1000); // kbps

  const rttGraph = asciiGraph("RTT", "ms", rttValues, 500);
  const lossGraph = asciiGraph("LOSS", "%", lossValues, 10);
  const bitrateGraph = asciiGraph("BITRATE", "kbps", bitrateValues, "auto");

  const latestRtt = stats?.rtt != null ? `${Math.round(stats.rtt)}ms` : "--";
  const latestLoss = stats?.packetLoss != null ? `${stats.packetLoss.toFixed(1)}%` : "--";
  const latestBitrate = stats?.bitrate != null
    ? stats.bitrate > 1_000_000
      ? `${(stats.bitrate / 1_000_000).toFixed(1)} Mbps`
      : `${Math.round(stats.bitrate / 1000)} kbps`
    : "--";
  const latestCodec = stats?.codec || "--";
  const latestRes = stats?.resolution || "--";
  const latestFps = stats?.fps != null ? `${stats.fps}fps` : "--";

  return (
    <div className="diag-panel">
      <pre>
{`> CONNECTION DIAGNOSTICS
──────────────────────────────────────
 RTT: ${latestRtt}  |  LOSS: ${latestLoss}  |  ${latestBitrate}
 TYPE: ${(connectionType || "--").toUpperCase()}  |  QUALITY: ${(connectionQuality || "--").toUpperCase()}
 CODEC: ${latestCodec.toUpperCase()}  |  ${latestRes}@${latestFps}
──────────────────────────────────────

${rttGraph}

${lossGraph}

${bitrateGraph}`}
      </pre>
    </div>
  );
}
