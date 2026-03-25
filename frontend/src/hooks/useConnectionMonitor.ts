import { useRef, useState, useEffect, useCallback, type MutableRefObject } from "react";
import type { SignalingState, ConnectionQuality, ConnectionType, ConnectionStats } from "../types";

const ICE_RESTART_DELAY = 15000; // wait 15s on "disconnected" before restarting
const MAX_RESTART_ATTEMPTS = 3;
const CONNECTION_TIMEOUT = 30000; // 30s to establish initial connection
const STATS_INTERVAL = 3000; // poll stats every 3s

interface BandwidthTier {
  maxBitrate: number;
  scaleDown: number;
  maxFramerate: number;
}

const BANDWIDTH_TIERS: Record<ConnectionQuality, BandwidthTier> = {
  excellent: { maxBitrate: 2_500_000, scaleDown: 1, maxFramerate: 30 },
  good:      { maxBitrate: 1_200_000, scaleDown: 1, maxFramerate: 24 },
  poor:      { maxBitrate:   500_000, scaleDown: 2, maxFramerate: 15 },
  critical:  { maxBitrate:   150_000, scaleDown: 4, maxFramerate: 10 },
};

export interface ConnectionMonitorResult {
  connectionQuality: ConnectionQuality | null;
  connectionType: ConnectionType | null;
  stats: ConnectionStats | null;
  isRecovering: boolean;
  recoveryFailed: boolean;
  timeoutExpired: boolean;
  setTimeoutExpired: (value: boolean) => void;
}

export default function useConnectionMonitor(
  pcRef: MutableRefObject<RTCPeerConnection | null>,
  signalingState: SignalingState,
  connectionState: string
): ConnectionMonitorResult {
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality | null>(null);
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [timeoutExpired, setTimeoutExpired] = useState(false);

  const restartAttemptsRef = useRef(0);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBytesRef = useRef(0);
  const prevTimestampRef = useRef(0);
  const signalingStateRef = useRef(signalingState);
  signalingStateRef.current = signalingState;

  const clearTimers = useCallback(() => {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    disconnectTimerRef.current = null;
    timeoutTimerRef.current = null;
    statsIntervalRef.current = null;
  }, []);

  const attemptRestart = useCallback(() => {
    const pc = pcRef.current;
    if (!pc) return;

    if (signalingStateRef.current !== "open") {
      // Can't restart without signaling — will retry when signaling recovers
      return;
    }

    if (restartAttemptsRef.current >= MAX_RESTART_ATTEMPTS) {
      setIsRecovering(false);
      setRecoveryFailed(true);
      return;
    }

    restartAttemptsRef.current++;
    setIsRecovering(true);
    pc.restartIce(); // triggers onnegotiationneeded → new offer with ice-restart
  }, [pcRef]);

  // React to connection state changes
  useEffect(() => {
    if (connectionState === "connected") {
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      disconnectTimerRef.current = null;
      timeoutTimerRef.current = null;
      restartAttemptsRef.current = 0;
      setIsRecovering(false);
      setRecoveryFailed(false);
      setTimeoutExpired(false);
    } else if (connectionState === "disconnected") {
      if (!disconnectTimerRef.current) {
        disconnectTimerRef.current = setTimeout(() => {
          disconnectTimerRef.current = null;
          attemptRestart();
        }, ICE_RESTART_DELAY);
      }
    } else if (connectionState === "failed") {
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
      attemptRestart();
    } else if (connectionState === "closed" || connectionState === "new") {
      clearTimers();
      setConnectionQuality(null);
      setConnectionType(null);
      setStats(null);
      setIsRecovering(false);
      setRecoveryFailed(false);
      prevBytesRef.current = 0;
      prevTimestampRef.current = 0;
    }
  }, [connectionState, attemptRestart, clearTimers]);

  // Connection timeout — start when we first enter a non-new, non-connected state
  useEffect(() => {
    if (
      connectionState === "connecting" ||
      connectionState === "new"
    ) {
      if (!timeoutTimerRef.current) {
        timeoutTimerRef.current = setTimeout(() => {
          timeoutTimerRef.current = null;
          if (pcRef.current && pcRef.current.connectionState !== "connected") {
            setTimeoutExpired(true);
          }
        }, CONNECTION_TIMEOUT);
      }
    }
    if (connectionState === "connected") {
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  }, [connectionState, pcRef]);

  // Retry ICE restart when signaling recovers
  useEffect(() => {
    if (signalingState === "open" && isRecovering) {
      attemptRestart();
    }
  }, [signalingState, isRecovering, attemptRestart]);

  // Quality monitoring via getStats()
  useEffect(() => {
    if (connectionState !== "connected") {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
      return;
    }

    const pollStats = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let rtt: number | null = null;
        let packetsLost = 0;
        let packetsReceived = 0;
        let bytesReceived = 0;
         
        let activePair: any = null;
        let codec: string | null = null;
        let resolution: string | null = null;
        let fps: number | null = null;

        report.forEach((stat) => {
          if (stat.type === "candidate-pair" && (stat as RTCIceCandidatePairStats).state === "succeeded") {
            const pairStat = stat as RTCIceCandidatePairStats;
            rtt = pairStat.currentRoundTripTime != null
              ? pairStat.currentRoundTripTime * 1000
              : rtt;
            activePair = pairStat;
          }
          if (stat.type === "inbound-rtp") {
            const rtpStat = stat as RTCInboundRtpStreamStats;
            if (rtpStat.kind === "audio") {
              packetsLost += rtpStat.packetsLost || 0;
              packetsReceived += rtpStat.packetsReceived || 0;
              bytesReceived += rtpStat.bytesReceived || 0;
            }
            if (rtpStat.kind === "video") {
               
              const videoStat = rtpStat as any;
              if (videoStat.frameWidth && videoStat.frameHeight) {
                resolution = `${videoStat.frameWidth}x${videoStat.frameHeight}`;
              }
              if (videoStat.framesPerSecond) {
                fps = Math.round(videoStat.framesPerSecond);
              }
              if (videoStat.codecId) {
                const codecStat = report.get(videoStat.codecId);
                if (codecStat?.type === "codec") {
                   
                  const mimeType = (codecStat as any).mimeType as string | undefined;
                  if (mimeType) {
                    codec = mimeType.replace(/^video\//, "").replace(/^audio\//, "");
                  }
                }
              }
            }
          }
        });

        // Detect relay vs direct from active candidate pair
        if (activePair) {
          const local = report.get(activePair.localCandidateId);
          const remote = report.get(activePair.remoteCandidateId);
           
          const isRelay =
            (local as any)?.candidateType === "relay" ||
            (remote as any)?.candidateType === "relay";
          setConnectionType(isRelay ? "relay" : "direct");
        }

        const totalPackets = packetsReceived + packetsLost;
        const lossPercent = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

        const now = performance.now();
        const bitrate = prevTimestampRef.current > 0
          ? ((bytesReceived - prevBytesRef.current) * 8) / ((now - prevTimestampRef.current) / 1000)
          : 0;
        prevBytesRef.current = bytesReceived;
        prevTimestampRef.current = now;

        setStats({ rtt, packetLoss: lossPercent, bitrate, codec, resolution, fps });

        if (rtt != null) {
          if (rtt < 100 && lossPercent < 0.5) setConnectionQuality("excellent");
          else if (rtt < 250 && lossPercent < 2) setConnectionQuality("good");
          else if (rtt < 500 && lossPercent < 5) setConnectionQuality("poor");
          else setConnectionQuality("critical");
        }
      } catch {
        // Stats not available
      }
    };

    statsIntervalRef.current = setInterval(pollStats, STATS_INTERVAL);
    pollStats();

    return () => {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    };
  }, [connectionState, pcRef]);

  // Bandwidth adaptation — adjust video encoding when quality changes
  useEffect(() => {
    if (!connectionQuality) return;
    const pc = pcRef.current;
    if (!pc) return;

    const tier = BANDWIDTH_TIERS[connectionQuality];
    if (!tier) return;

    pc.getSenders().forEach(async (sender) => {
      if (sender.track?.kind !== "video") return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) return;
      params.encodings[0].maxBitrate = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      params.encodings[0].maxFramerate = tier.maxFramerate;
      try {
        await sender.setParameters(params);
      } catch { /* encoding params not supported */ }
    });
  }, [connectionQuality, pcRef]);

  // Cleanup on unmount
  useEffect(() => {
    return clearTimers;
  }, [clearTimers]);

  return {
    connectionQuality,
    connectionType,
    stats,
    isRecovering,
    recoveryFailed,
    timeoutExpired,
    setTimeoutExpired,
  };
}
