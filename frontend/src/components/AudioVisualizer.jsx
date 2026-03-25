import { useRef, useEffect, useState } from "react";

const ASCII_CHARS = "░▒▓█▄▀│┃╎╏▕▐▌";
const BAR_CHARS = [" ", "░", "▒", "▓", "█"];

export default function AudioVisualizer({ stream }) {
  const [lines, setLines] = useState([]);
  const animFrameRef = useRef(null);

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const COLS = 48;
    const ROWS = 16;
    const HALF = Math.floor(ROWS / 2);

    function render() {
      animFrameRef.current = requestAnimationFrame(render);
      analyser.getByteFrequencyData(dataArray);

      const step = bufferLength / COLS;
      const output = [];

      for (let row = 0; row < ROWS; row++) {
        let line = "";
        for (let col = 0; col < COLS; col++) {
          const idx = Math.floor(col * step);
          const value = dataArray[idx] / 255;
          // How many rows from center this bar fills
          const barHeight = Math.floor(value * HALF);
          const distFromCenter = Math.abs(row - HALF);

          if (distFromCenter <= barHeight && barHeight > 0) {
            // Intensity based on how close to center (center = strongest)
            const intensity = 1 - distFromCenter / (HALF + 1);
            const charIdx = Math.min(
              Math.floor(intensity * value * (BAR_CHARS.length - 1)) + 1,
              BAR_CHARS.length - 1
            );
            line += BAR_CHARS[charIdx];
          } else {
            line += " ";
          }
        }
        output.push(line);
      }

      setLines(output);
    }

    render();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      source.disconnect();
      audioCtx.close();
    };
  }, [stream]);

  return (
    <pre className="ascii-visualizer">
      {lines.map((line, i) => (
        <div key={i}>{line || " ".repeat(48)}</div>
      ))}
    </pre>
  );
}
