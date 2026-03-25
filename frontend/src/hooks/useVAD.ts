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
    if (!audioTrack) {
        setLocalSpeaking(false);
        return;
    }

    // Close previous context before creating new one to prevent AudioContext exhaustion
    if (localCtxRef.current && localCtxRef.current.state !== "closed") {
      localCtxRef.current.close().catch(() => {});
    }

    let ctx: AudioContext;
    try {
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch { return; }
    localCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let holdTimeout: any = null;
    const interval = setInterval(() => {
      if (ctx.state === "suspended") ctx.resume();
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
    };
  }, [localStream]);

  useEffect(() => {
    if (!remoteStream) {
      setRemoteSpeaking(false);
      return;
    }
    const audioTrack = remoteStream.getAudioTracks()[0];
    if (!audioTrack) {
        setRemoteSpeaking(false);
        return;
    }

    // Close previous context before creating new one to prevent AudioContext exhaustion
    if (remoteCtxRef.current && remoteCtxRef.current.state !== "closed") {
      remoteCtxRef.current.close().catch(() => {});
    }

    let ctx: AudioContext;
    try {
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch { return; }
    remoteCtxRef.current = ctx;

    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let holdTimeout: any = null;
    const interval = setInterval(() => {
      if (ctx.state === "suspended") ctx.resume();
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
    };
  }, [remoteStream]);

  return { localSpeaking, remoteSpeaking };
}
