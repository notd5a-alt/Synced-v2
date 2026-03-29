import { useState, useEffect, useRef, useMemo } from "react";
import type { PeerInfo } from "./useWebRTC";

// Voice Activity Detection for multiple remote peers + local stream.
// Returns localSpeaking + a Map<peerId, boolean> for remote peers.

const THRESHOLD = 15;
const POLL_MS = 100;
const HOLD_MS = 300;
const VOICE_BIN_START = 0;
const VOICE_BIN_END = 16;

interface VADContext {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array;
  interval: ReturnType<typeof setInterval>;
  holdTimeout: ReturnType<typeof setTimeout> | null;
  trackId: string;
}

function createVAD(
  audioTrack: MediaStreamTrack,
  onSpeaking: (speaking: boolean) => void,
): VADContext | null {
  let ctx: AudioContext;
  try {
    ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  } catch {
    return null;
  }

  const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let holdTimeout: ReturnType<typeof setTimeout> | null = null;
  const interval = setInterval(() => {
    if (audioTrack.readyState === "ended") return;
    if (ctx.state === "suspended") ctx.resume();
    analyser.getByteFrequencyData(data);
    let sum = 0;
    const end = Math.min(VOICE_BIN_END, data.length);
    for (let i = VOICE_BIN_START; i < end; i++) sum += data[i];
    const avg = sum / (end - VOICE_BIN_START);
    if (avg > THRESHOLD) {
      if (holdTimeout) clearTimeout(holdTimeout);
      holdTimeout = null;
      onSpeaking(true);
    } else if (!holdTimeout) {
      holdTimeout = setTimeout(() => onSpeaking(false), HOLD_MS);
    }
  }, POLL_MS);

  return { ctx, source, analyser, data, interval, holdTimeout, trackId: audioTrack.id };
}

function destroyVAD(vad: VADContext) {
  clearInterval(vad.interval);
  if (vad.holdTimeout) clearTimeout(vad.holdTimeout);
  vad.source.disconnect();
  vad.analyser.disconnect();
  vad.ctx.close().catch(() => {});
}

export default function useMultiVAD(
  localStream: MediaStream | null,
  peers: Map<string, PeerInfo>,
): { localSpeaking: boolean; peerSpeaking: Map<string, boolean> } {
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [speakingMap, setSpeakingMap] = useState<Map<string, boolean>>(new Map());

  // --- Local VAD ---
  const localVadRef = useRef<VADContext | null>(null);

  useEffect(() => {
    if (!localStream) {
      setLocalSpeaking(false);
      if (localVadRef.current) {
        destroyVAD(localVadRef.current);
        localVadRef.current = null;
      }
      return;
    }
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) {
      setLocalSpeaking(false);
      return;
    }
    if (localVadRef.current?.trackId === audioTrack.id) return;

    if (localVadRef.current) destroyVAD(localVadRef.current);
    localVadRef.current = createVAD(audioTrack, setLocalSpeaking);

    return () => {
      if (localVadRef.current) {
        destroyVAD(localVadRef.current);
        localVadRef.current = null;
      }
    };
  }, [localStream]);

  // --- Remote peer VADs ---
  const peerVadsRef = useRef<Map<string, VADContext>>(new Map());

  useEffect(() => {
    const currentPeerIds = new Set<string>();

    for (const [peerId, peer] of peers) {
      currentPeerIds.add(peerId);
      const audioTrack = peer.remoteStream.getAudioTracks()[0];
      const existing = peerVadsRef.current.get(peerId);

      if (!audioTrack || audioTrack.readyState === "ended") {
        // No audio — tear down if exists
        if (existing) {
          destroyVAD(existing);
          peerVadsRef.current.delete(peerId);
          setSpeakingMap((prev) => {
            const next = new Map(prev);
            next.delete(peerId);
            return next;
          });
        }
        continue;
      }

      // Already tracking same track
      if (existing?.trackId === audioTrack.id) continue;

      // New or changed track
      if (existing) destroyVAD(existing);

      const vad = createVAD(audioTrack, (speaking) => {
        setSpeakingMap((prev) => {
          if (prev.get(peerId) === speaking) return prev;
          const next = new Map(prev);
          next.set(peerId, speaking);
          return next;
        });
      });
      if (vad) peerVadsRef.current.set(peerId, vad);
    }

    // Clean up VADs for removed peers
    for (const [peerId, vad] of peerVadsRef.current) {
      if (!currentPeerIds.has(peerId)) {
        destroyVAD(vad);
        peerVadsRef.current.delete(peerId);
        setSpeakingMap((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      }
    }

    const vadsMap = peerVadsRef.current;
    return () => {
      for (const [, vad] of vadsMap) {
        destroyVAD(vad);
      }
      vadsMap.clear();
    };
  }, [peers]);

  // Stable reference for the speaking map
  const stableSpeakingMap = useMemo(() => speakingMap, [speakingMap]);

  return { localSpeaking, peerSpeaking: stableSpeakingMap };
}
