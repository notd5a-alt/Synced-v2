import { useState, useEffect, useRef } from "react";

// Voice Activity Detection — detects if an audio stream is "speaking"
// Uses AnalyserNode to measure volume; returns boolean per stream.
const THRESHOLD = 15; // min average amplitude to count as speaking
const POLL_MS = 100; // check every 100ms
const HOLD_MS = 300; // stay "speaking" for 300ms after last detection (debounce)

export default function useVAD(
  localStream: MediaStream | null,
  remoteStream: MediaStream | null
): { localSpeaking: boolean; remoteSpeaking: boolean } {
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);

  const localCtxRef = useRef<AudioContext | null>(null);
  const remoteCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!localStream) {
      setLocalSpeaking(false);
      return;
    }
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    localCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let holdTimeout: ReturnType<typeof setTimeout> | null = null;
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      if (avg > THRESHOLD) {
        if (holdTimeout) clearTimeout(holdTimeout);
        holdTimeout = null;
        setLocalSpeaking(true);
      } else if (!holdTimeout) {
        holdTimeout = setTimeout(() => setLocalSpeaking(false), HOLD_MS);
      }
    }, POLL_MS);

    return () => {
      clearInterval(interval);
      if (holdTimeout) clearTimeout(holdTimeout);
      source.disconnect();
      ctx.close().catch(() => {});
      localCtxRef.current = null;
    };
  }, [localStream]);

  useEffect(() => {
    if (!remoteStream) {
      setRemoteSpeaking(false);
      return;
    }
    const audioTrack = remoteStream.getAudioTracks()[0];
    if (!audioTrack) return;

    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    remoteCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let holdTimeout: ReturnType<typeof setTimeout> | null = null;
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
      if (avg > THRESHOLD) {
        if (holdTimeout) clearTimeout(holdTimeout);
        holdTimeout = null;
        setRemoteSpeaking(true);
      } else if (!holdTimeout) {
        holdTimeout = setTimeout(() => setRemoteSpeaking(false), HOLD_MS);
      }
    }, POLL_MS);

    return () => {
      clearInterval(interval);
      if (holdTimeout) clearTimeout(holdTimeout);
      source.disconnect();
      ctx.close().catch(() => {});
      remoteCtxRef.current = null;
    };
  }, [remoteStream]);

  return { localSpeaking, remoteSpeaking };
}
