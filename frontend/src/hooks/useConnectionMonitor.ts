import { useRef, useState, useEffect, useCallback, type MutableRefObject } from "react";
import type { SignalingState, ConnectionQuality, ConnectionType, ConnectionStats } from "../types";

const ICE_RESTART_DELAY = 15000; // wait 15s on "disconnected" before restarting
const MAX_RESTART_ATTEMPTS = 3;
const ICE_RESTART_TIMEOUT = 15000; // declare failure if restart doesn't connect in 15s
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

// Higher bitrate tiers for screen share content (text/code needs more bits)
const SCREEN_BANDWIDTH_TIERS: Record<ConnectionQuality, BandwidthTier> = {
  excellent: { maxBitrate: 4_000_000, scaleDown: 1, maxFramerate: 30 },
  good:      { maxBitrate: 2_000_000, scaleDown: 1, maxFramerate: 24 },
  poor:      { maxBitrate:   800_000, scaleDown: 1, maxFramerate: 10 },
  critical:  { maxBitrate:   300_000, scaleDown: 2, maxFramerate: 5 },
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
  const restartTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBytesRef = useRef(0);
  const prevTimestampRef = useRef(0);
  const smoothBitrateRef = useRef(0);
  // Interval-based packet loss tracking (not cumulative)
  const prevPacketsLostRef = useRef(0);
  const prevPacketsReceivedRef = useRef(0);
  const qualityCountRef = useRef(0); // consecutive samples at candidate quality
  const candidateQualityRef = useRef<ConnectionQuality | null>(null);
  const signalingStateRef = useRef(signalingState);
  signalingStateRef.current = signalingState;

  const clearTimers = useCallback(() => {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    disconnectTimerRef.current = null;
    timeoutTimerRef.current = null;
    restartTimeoutRef.current = null;
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
    // Clear connection timeout — ICE restart extends the connection lifecycle (H8)
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    try {
      pc.restartIce(); // triggers onnegotiationneeded → new offer with ice-restart
      // Start a timeout — if restart doesn't produce "connected" in time, try again
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = setTimeout(() => {
        restartTimeoutRef.current = null;
        const pc = pcRef.current;
        if (pc && pc.connectionState !== "connected") {
          attemptRestart();
        }
      }, ICE_RESTART_TIMEOUT);
    } catch {
      // restartIce can fail if connection is already closed
      setIsRecovering(false);
      setRecoveryFailed(true);
    }
  }, [pcRef]);

  // React to connection state changes
  useEffect(() => {
    if (connectionState === "connected") {
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      if (restartTimeoutRef.current) clearTimeout(restartTimeoutRef.current);
      disconnectTimerRef.current = null;
      timeoutTimerRef.current = null;
      restartTimeoutRef.current = null;
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
      smoothBitrateRef.current = 0;
      prevPacketsLostRef.current = 0;
      prevPacketsReceivedRef.current = 0;
      qualityCountRef.current = 0;
      candidateQualityRef.current = null;
    }
  }, [connectionState, attemptRestart, clearTimers]);

  // Connection timeout — only start when actual negotiation begins ("connecting"),
  // not on "new" which is the idle state before any peer joins
  useEffect(() => {
    if (connectionState === "connecting") {
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
  const pollingRef = useRef(false); // guard against overlapping polls (C5)
  useEffect(() => {
    if (connectionState !== "connected") {
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
      return;
    }

    const pollStats = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      // Skip if previous poll is still running (C5) — prevents hysteresis corruption
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const report = await pc.getStats();
        let rtt: number | null = null;
        // Track video packet loss separately — audio FEC makes audio loss tolerable,
        // so only video loss should trigger quality downgrades (M4)
        let videoPacketsLost = 0;
        let videoPacketsReceived = 0;
        let totalBytesReceived = 0;

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
            // Accumulate bytes from both audio and video for bitrate
            totalBytesReceived += rtpStat.bytesReceived || 0;
            // Only track video packet loss for quality classification (M4)
            // Audio FEC handles audio loss effectively, so it shouldn't downgrade quality
            if (rtpStat.kind === "video") {
              videoPacketsLost += rtpStat.packetsLost || 0;
              videoPacketsReceived += rtpStat.packetsReceived || 0;
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

        // Compute interval-based video packet loss (not cumulative) for responsive quality signal
        const intervalLost = videoPacketsLost - prevPacketsLostRef.current;
        const intervalReceived = videoPacketsReceived - prevPacketsReceivedRef.current;
        const intervalTotal = intervalReceived + intervalLost;
        const lossPercent = intervalTotal > 0 ? (intervalLost / intervalTotal) * 100 : 0;
        prevPacketsLostRef.current = videoPacketsLost;
        prevPacketsReceivedRef.current = videoPacketsReceived;

        const now = performance.now();
        const instantBitrate = prevTimestampRef.current > 0
          ? ((totalBytesReceived - prevBytesRef.current) * 8) / ((now - prevTimestampRef.current) / 1000)
          : 0;
        prevBytesRef.current = totalBytesReceived;
        prevTimestampRef.current = now;

        // EWMA smoothing (α=0.3) to reduce jitter in bitrate readings
        const alpha = 0.3;
        smoothBitrateRef.current = smoothBitrateRef.current === 0
          ? instantBitrate
          : alpha * instantBitrate + (1 - alpha) * smoothBitrateRef.current;
        const bitrate = smoothBitrateRef.current;

        setStats({ rtt, packetLoss: lossPercent, bitrate, codec, resolution, fps });

        // Quality classification with dead-zone hysteresis (M3)
        // Uses asymmetric thresholds: tighter to upgrade, looser to downgrade.
        // This prevents oscillation at boundaries (e.g., RTT 95↔105ms).
        if (rtt != null) {
          const current = connectionQuality;
          let rawQuality: ConnectionQuality;

          if (current === "good") {
            // To upgrade to excellent: need RTT < 80 (not 100) — tighter
            // To downgrade to poor: need RTT > 300 (not 250) — looser
            if (rtt < 80 && lossPercent < 0.3) rawQuality = "excellent";
            else if (rtt >= 300 || lossPercent >= 3) rawQuality = "poor";
            else rawQuality = "good";
          } else if (current === "excellent") {
            // To downgrade to good: need RTT > 120 (not 100) — dead zone
            if (rtt > 120 || lossPercent > 0.8) rawQuality = "good";
            else rawQuality = "excellent";
          } else if (current === "poor") {
            // To upgrade to good: need RTT < 200
            // To downgrade to critical: need RTT > 600
            if (rtt < 200 && lossPercent < 1.5) rawQuality = "good";
            else if (rtt >= 600 || lossPercent >= 7) rawQuality = "critical";
            else rawQuality = "poor";
          } else {
            // current is "critical" or null — use standard thresholds
            if (rtt < 100 && lossPercent < 0.5) rawQuality = "excellent";
            else if (rtt < 250 && lossPercent < 2) rawQuality = "good";
            else if (rtt < 500 && lossPercent < 5) rawQuality = "poor";
            else rawQuality = "critical";
          }

          if (rawQuality === candidateQualityRef.current) {
            qualityCountRef.current++;
          } else {
            candidateQualityRef.current = rawQuality;
            qualityCountRef.current = 1;
          }

          // Apply immediately on first reading or after 2 consecutive samples
          if (current === null || qualityCountRef.current >= 2) {
            if (rawQuality !== current) {
              setConnectionQuality(rawQuality);
            }
          }
        }
      } catch {
        // Stats not available
      } finally {
        pollingRef.current = false;
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
  // Also re-applies when stats update (every 3s) to catch newly-added video senders
  const applyingParamsRef = useRef(false);
  const lastTierRef = useRef<BandwidthTier | null>(null);
  useEffect(() => {
    if (!connectionQuality) return;
    const pc = pcRef.current;
    if (!pc) return;

    // Skip if a previous update is still in flight to prevent concurrent setParameters()
    if (applyingParamsRef.current) return;

    const applyParams = async () => {
      applyingParamsRef.current = true;
      try {
        const senders = pc.getSenders();
        for (const sender of senders) {
          if (sender.track?.kind !== "video") continue;
          // Use higher bitrate tiers for screen share content
          // Detect via contentHint ("detail"/"text") or non-camera label (H7)
          const hint = sender.track.contentHint;
          const isScreenShare = hint === "detail" || hint === "text" || sender.track.label?.includes("screen");
          const tier = isScreenShare
            ? SCREEN_BANDWIDTH_TIERS[connectionQuality]
            : BANDWIDTH_TIERS[connectionQuality];
          if (!tier) continue;
          lastTierRef.current = tier;
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) continue;
          // Skip if already at correct bitrate (avoids redundant setParameters calls)
          if (params.encodings[0].maxBitrate === tier.maxBitrate) continue;
          params.encodings[0].maxBitrate = tier.maxBitrate;
          params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
          params.encodings[0].maxFramerate = tier.maxFramerate;
          try {
            await sender.setParameters(params);
          } catch { /* encoding params not supported */ }
        }
      } finally {
        applyingParamsRef.current = false;
      }
    };

    applyParams();
  }, [connectionQuality, pcRef]); // H6: removed stats — only quality changes trigger adaptation

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
