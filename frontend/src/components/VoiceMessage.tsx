import { useState, useRef, useCallback, useEffect } from "react";
import AudioVisualizer from "./AudioVisualizer";
import { formatDuration } from "../utils/formatTime";

interface VoiceMessageProps {
  blobUrl: string;
  duration: number;
  userColor?: string;
}

/**
 * Inline voice message with play/pause, progress, duration,
 * and an always-visible Three.js AudioVisualizer.
 */
export default function VoiceMessage({ blobUrl, duration, userColor }: VoiceMessageProps) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef(0);
  const bufferRef = useRef<AudioBuffer | null>(null);

  // Create a silent MediaStream on mount so the visualizer is always visible.
  // When playback starts, the real audio routes through the same destination.
  useEffect(() => {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current = ctx;
    const dest = ctx.createMediaStreamDestination();
    destRef.current = dest;
    setStream(dest.stream);

    return () => {
      cancelAnimationFrame(animRef.current);
      try { sourceRef.current?.stop(); } catch { /* ok */ }
      ctx.close().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(animRef.current);
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch { /* already stopped */ }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    setPlaying(false);
    setProgress(0);
  }, []);

  const play = useCallback(async () => {
    if (playing) { stop(); return; }

    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === "suspended") await ctx.resume();

    // Decode audio buffer if not cached
    if (!bufferRef.current) {
      try {
        const resp = await fetch(blobUrl);
        const arrayBuf = await resp.arrayBuffer();
        bufferRef.current = await ctx.decodeAudioData(arrayBuf);
      } catch (err) {
        console.error("Failed to decode voice message:", err);
        return;
      }
    }

    // Create source → destination (feeds AudioVisualizer) + speakers
    const source = ctx.createBufferSource();
    source.buffer = bufferRef.current;

    if (destRef.current) source.connect(destRef.current);
    source.connect(ctx.destination); // play through speakers

    source.onended = () => stop();

    source.start();
    sourceRef.current = source;
    startTimeRef.current = ctx.currentTime;
    setPlaying(true);

    // Progress tracking
    const totalDur = bufferRef.current.duration;
    const tick = () => {
      if (!sourceRef.current) return;
      const elapsed = ctx.currentTime - startTimeRef.current;
      setProgress(Math.min(elapsed / totalDur, 1));
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
  }, [playing, blobUrl, stop]);

  return (
    <div className="voice-message">
      <button className="btn voice-play-btn" onClick={play} type="button">
        {playing ? "[ || ]" : "[ > ]"}
      </button>
      <div className="voice-body">
        <div className="voice-visualizer">
          {stream && <AudioVisualizer stream={stream} userColor={userColor} />}
        </div>
        <div className="voice-meta">
          <div className="voice-progress-bar">
            <div className="voice-progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="voice-duration">{formatDuration(duration)}</span>
        </div>
      </div>
    </div>
  );
}
