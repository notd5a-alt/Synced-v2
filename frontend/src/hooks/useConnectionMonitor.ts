import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import type { PeerInfo } from "./useWebRTC";
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

const QUALITY_RANK: Record<ConnectionQuality, number> = {
  excellent: 0, good: 1, poor: 2, critical: 3,
};

// ---------------------------------------------------------------------------
// Per-peer monitoring state (stored in a ref Map)
// ---------------------------------------------------------------------------
interface PeerMonitorState {
  // ICE restart
  restartAttempts: number;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  restartTimeout: ReturnType<typeof setTimeout> | null;
  isRecovering: boolean;
  recoveryFailed: boolean;
  // Stats tracking
  prevBytes: number;
  prevTimestamp: number;
  smoothBitrate: number;
  prevPacketsLost: number;
  prevPacketsReceived: number;
  qualityCount: number;
  candidateQuality: ConnectionQuality | null;
  quality: ConnectionQuality | null;
  type: ConnectionType | null;
  stats: ConnectionStats | null;
  // State tracking
  prevConnectionState: RTCPeerConnectionState;
  applyingParams: boolean;
}

function createPeerMonitor(): PeerMonitorState {
  return {
    restartAttempts: 0,
    disconnectTimer: null,
    restartTimeout: null,
    isRecovering: false,
    recoveryFailed: false,
    prevBytes: 0,
    prevTimestamp: 0,
    smoothBitrate: 0,
    prevPacketsLost: 0,
    prevPacketsReceived: 0,
    qualityCount: 0,
    candidateQuality: null,
    quality: null,
    type: null,
    stats: null,
    // Start as "new" so the first real connectionState triggers a transition
    prevConnectionState: "new",
    applyingParams: false,
  };
}

function cleanupPeerMonitor(pm: PeerMonitorState) {
  if (pm.disconnectTimer) clearTimeout(pm.disconnectTimer);
  if (pm.restartTimeout) clearTimeout(pm.restartTimeout);
  pm.disconnectTimer = null;
  pm.restartTimeout = null;
}

function resetPeerMonitorStats(pm: PeerMonitorState) {
  pm.prevBytes = 0;
  pm.prevTimestamp = 0;
  pm.smoothBitrate = 0;
  pm.prevPacketsLost = 0;
  pm.prevPacketsReceived = 0;
  pm.qualityCount = 0;
  pm.candidateQuality = null;
  pm.quality = null;
  pm.type = null;
  pm.stats = null;
}

// ---------------------------------------------------------------------------
// Exported interface
// ---------------------------------------------------------------------------
export interface ConnectionMonitorResult {
  connectionQuality: ConnectionQuality | null;
  connectionType: ConnectionType | null;
  stats: ConnectionStats | null;
  isRecovering: boolean;
  recoveryFailed: boolean;
  timeoutExpired: boolean;
  setTimeoutExpired: (value: boolean) => void;
  peerQualities: Map<string, ConnectionQuality | null>;
}

// ---------------------------------------------------------------------------
// Quality classification with dead-zone hysteresis
// ---------------------------------------------------------------------------
function classifyQuality(
  rtt: number,
  lossPercent: number,
  current: ConnectionQuality | null,
): ConnectionQuality {
  if (current === "good") {
    if (rtt < 80 && lossPercent < 0.3) return "excellent";
    if (rtt >= 300 || lossPercent >= 3) return "poor";
    return "good";
  } else if (current === "excellent") {
    if (rtt > 120 || lossPercent > 0.8) return "good";
    return "excellent";
  } else if (current === "poor") {
    if (rtt < 200 && lossPercent < 1.5) return "good";
    if (rtt >= 600 || lossPercent >= 7) return "critical";
    return "poor";
  } else {
    // current is "critical" or null — standard thresholds
    if (rtt < 100 && lossPercent < 0.5) return "excellent";
    if (rtt < 250 && lossPercent < 2) return "good";
    if (rtt < 500 && lossPercent < 5) return "poor";
    return "critical";
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export default function useConnectionMonitor(
  peers: Map<string, PeerInfo>,
  signalingState: SignalingState,
): ConnectionMonitorResult {
  // --- React state (aggregated outputs) ---
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality | null>(null);
  const [connectionType, setConnectionType] = useState<ConnectionType | null>(null);
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [timeoutExpired, setTimeoutExpired] = useState(false);
  const [peerQualities, setPeerQualities] = useState<Map<string, ConnectionQuality | null>>(new Map());

  // --- Refs ---
  const monitorsRef = useRef<Map<string, PeerMonitorState>>(new Map());
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const signalingStateRef = useRef(signalingState);
  signalingStateRef.current = signalingState;

  const statsIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingRef = useRef(false);

  // Derive overall connection state from peers (for timeout logic)
  const overallConnectionState = (() => {
    if (peers.size === 0) return "new";
    let hasConnecting = false;
    for (const p of peers.values()) {
      if (p.connectionState === "connected") return "connected";
      if (p.connectionState === "connecting") hasConnecting = true;
    }
    if (hasConnecting) return "connecting";
    // All peers are disconnected/failed/closed/new
    for (const p of peers.values()) {
      if (p.connectionState === "disconnected") return "disconnected";
    }
    for (const p of peers.values()) {
      if (p.connectionState === "failed") return "failed";
    }
    return "new";
  })();

  // ----- Per-peer ICE restart -----
  const attemptPeerRestart = useCallback((peerId: string, pc: RTCPeerConnection) => {
    const mon = monitorsRef.current.get(peerId);
    if (!mon) return;

    if (signalingStateRef.current !== "open") return;

    if (mon.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      mon.isRecovering = false;
      mon.recoveryFailed = true;
      recomputeAggregate();
      return;
    }

    mon.restartAttempts++;
    mon.isRecovering = true;
    recomputeAggregate();

    // Clear connection timeout
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
    try {
      pc.restartIce();
      if (mon.restartTimeout) clearTimeout(mon.restartTimeout);
      mon.restartTimeout = setTimeout(() => {
        mon.restartTimeout = null;
        const peer = peersRef.current.get(peerId);
        if (peer && peer.connectionState !== "connected") {
          attemptPeerRestart(peerId, peer.pc);
        }
      }, ICE_RESTART_TIMEOUT);
    } catch {
      mon.isRecovering = false;
      mon.recoveryFailed = true;
      recomputeAggregate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Aggregate computation -----
  // eslint-disable-next-line react-hooks/exhaustive-deps
  function recomputeAggregate() {
    const monitors = monitorsRef.current;
    let worstQuality: ConnectionQuality | null = null;
    let worstType: ConnectionType | null = null;
    let worstStats: ConnectionStats | null = null;
    let anyRecovering = false;
    let anyFailed = false;
    const qualities = new Map<string, ConnectionQuality | null>();

    for (const [id, mon] of monitors) {
      qualities.set(id, mon.quality);
      if (mon.isRecovering) anyRecovering = true;
      if (mon.recoveryFailed) anyFailed = true;

      if (mon.quality != null) {
        if (worstQuality == null || QUALITY_RANK[mon.quality] > QUALITY_RANK[worstQuality]) {
          worstQuality = mon.quality;
          worstType = mon.type;
          worstStats = mon.stats;
        }
      }
    }

    setConnectionQuality(worstQuality);
    setConnectionType(worstType);
    setStats(worstStats);
    setIsRecovering(anyRecovering);
    setRecoveryFailed(anyFailed);
    setPeerQualities(qualities);
  }

  // Stable key for peer identity + connection states — drives the sync effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const peerStateKey = useMemo(() => {
    const parts: string[] = [];
    for (const [id, p] of peers) parts.push(`${id}:${p.connectionState}`);
    return parts.sort().join(",");
  }, [peers]);

  // ----- Sync monitors with peers map & handle state transitions -----
  useEffect(() => {
    const monitors = monitorsRef.current;
    const currentPeerIds = new Set(peers.keys());

    // Remove stale monitors
    for (const [id, mon] of monitors) {
      if (!currentPeerIds.has(id)) {
        cleanupPeerMonitor(mon);
        monitors.delete(id);
      }
    }

    // Add new monitors & handle state transitions
    for (const [id, peer] of peers) {
      let mon = monitors.get(id);
      if (!mon) {
        mon = createPeerMonitor();
        monitors.set(id, mon);
      }

      // Detect connection state transitions
      const prev = mon.prevConnectionState;
      const curr = peer.connectionState;
      if (prev !== curr) {
        mon.prevConnectionState = curr;

        if (curr === "connected") {
          if (mon.disconnectTimer) clearTimeout(mon.disconnectTimer);
          if (mon.restartTimeout) clearTimeout(mon.restartTimeout);
          mon.disconnectTimer = null;
          mon.restartTimeout = null;
          mon.restartAttempts = 0;
          mon.isRecovering = false;
          mon.recoveryFailed = false;
        } else if (curr === "disconnected") {
          if (!mon.disconnectTimer) {
            const capturedId = id;
            mon.disconnectTimer = setTimeout(() => {
              mon!.disconnectTimer = null;
              const p = peersRef.current.get(capturedId);
              if (p) attemptPeerRestart(capturedId, p.pc);
            }, ICE_RESTART_DELAY);
          }
        } else if (curr === "failed") {
          if (mon.disconnectTimer) clearTimeout(mon.disconnectTimer);
          mon.disconnectTimer = null;
          attemptPeerRestart(id, peer.pc);
        } else if (curr === "closed" || curr === "new") {
          cleanupPeerMonitor(mon);
          resetPeerMonitorStats(mon);
          mon.restartAttempts = 0;
          mon.isRecovering = false;
          mon.recoveryFailed = false;
        }
      }
    }

    recomputeAggregate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerStateKey]); // only re-run when peers join/leave or change connectionState

  // ----- Connection timeout -----
  useEffect(() => {
    if (overallConnectionState === "connecting") {
      if (!timeoutTimerRef.current) {
        timeoutTimerRef.current = setTimeout(() => {
          timeoutTimerRef.current = null;
          // Check if still no connected peers
          let anyConnected = false;
          for (const p of peersRef.current.values()) {
            if (p.connectionState === "connected") { anyConnected = true; break; }
          }
          if (!anyConnected) {
            setTimeoutExpired(true);
          }
        }, CONNECTION_TIMEOUT);
      }
    }
    if (overallConnectionState === "connected") {
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
      setTimeoutExpired(false);
    }
    if (overallConnectionState === "new") {
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
      // Full reset
      setConnectionQuality(null);
      setConnectionType(null);
      setStats(null);
      setIsRecovering(false);
      setRecoveryFailed(false);
    }
  }, [overallConnectionState]);

  // ----- Retry ICE restart when signaling recovers -----
  useEffect(() => {
    if (signalingState !== "open") return;
    for (const [id, mon] of monitorsRef.current) {
      if (mon.isRecovering) {
        const peer = peersRef.current.get(id);
        if (peer) attemptPeerRestart(id, peer.pc);
      }
    }
  }, [signalingState, attemptPeerRestart]);

  // ----- Stats polling (iterates all connected peers) -----
  useEffect(() => {
    const hasConnected = overallConnectionState === "connected";
    if (!hasConnected) {
      if (statsIntervalRef.current) clearTimeout(statsIntervalRef.current);
      statsIntervalRef.current = null;
      return;
    }

    const pollAllPeers = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        for (const [id, peer] of peersRef.current) {
          if (peer.connectionState !== "connected") continue;
          const mon = monitorsRef.current.get(id);
          if (!mon) continue;
          await pollPeerStats(peer.pc, mon);
        }
        recomputeAggregate();
      } finally {
        pollingRef.current = false;
      }
    };

    const FAST_INTERVAL = 500;
    const FAST_POLLS = 3;
    let pollCount = 0;

    const schedulePoll = () => {
      const interval = pollCount < FAST_POLLS ? FAST_INTERVAL : STATS_INTERVAL;
      statsIntervalRef.current = setTimeout(() => {
        pollAllPeers().then(() => {
          pollCount++;
          schedulePoll();
        });
      }, interval);
    };

    pollAllPeers().then(() => { pollCount++; schedulePoll(); });

    return () => {
      if (statsIntervalRef.current) clearTimeout(statsIntervalRef.current);
      statsIntervalRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overallConnectionState]);

  // ----- Bandwidth adaptation (all peers) -----
  useEffect(() => {
    if (!connectionQuality) return;

    const applyAllPeers = async () => {
      for (const [id, peer] of peersRef.current) {
        const mon = monitorsRef.current.get(id);
        if (!mon || mon.applyingParams) continue;
        mon.applyingParams = true;
        try {
          for (const sender of peer.pc.getSenders()) {
            if (sender.track?.kind !== "video") continue;
            const hint = sender.track.contentHint;
            const isScreenShare = hint === "detail" || hint === "text";
            const tier = isScreenShare
              ? SCREEN_BANDWIDTH_TIERS[connectionQuality]
              : BANDWIDTH_TIERS[connectionQuality];
            if (!tier) continue;
            const params = sender.getParameters();
            if (!params.encodings?.length) continue;
            if (params.encodings[0].maxBitrate === tier.maxBitrate) continue;
            params.encodings[0].maxBitrate = tier.maxBitrate;
            params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
            params.encodings[0].maxFramerate = tier.maxFramerate;
            (params.encodings[0] as any).degradationPreference = "maintain-framerate";
            try { await sender.setParameters(params); } catch { /* not supported */ }
          }
        } finally {
          mon.applyingParams = false;
        }
      }
    };

    applyAllPeers();
  }, [connectionQuality]);

  // ----- Cleanup on unmount -----
  useEffect(() => {
    return () => {
      for (const mon of monitorsRef.current.values()) {
        cleanupPeerMonitor(mon);
      }
      if (statsIntervalRef.current) clearTimeout(statsIntervalRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
    };
  }, []);

  return {
    connectionQuality,
    connectionType,
    stats,
    isRecovering,
    recoveryFailed,
    timeoutExpired,
    setTimeoutExpired,
    peerQualities,
  };
}

// ---------------------------------------------------------------------------
// Poll stats for a single peer's PC and update its monitor state
// ---------------------------------------------------------------------------
async function pollPeerStats(pc: RTCPeerConnection, mon: PeerMonitorState) {
  try {
    const report = await pc.getStats();
    let rtt: number | null = null;
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
        totalBytesReceived += rtpStat.bytesReceived || 0;
        if (rtpStat.kind === "video") {
          videoPacketsLost += rtpStat.packetsLost || 0;
          videoPacketsReceived += rtpStat.packetsReceived || 0;
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

    // Connection type
    if (activePair) {
      const local = report.get(activePair.localCandidateId);
      const remote = report.get(activePair.remoteCandidateId);
      const isRelay =
        (local as any)?.candidateType === "relay" ||
        (remote as any)?.candidateType === "relay";
      mon.type = isRelay ? "relay" : "direct";
    }

    // Interval-based packet loss
    const intervalLost = videoPacketsLost - mon.prevPacketsLost;
    const intervalReceived = videoPacketsReceived - mon.prevPacketsReceived;
    const intervalTotal = intervalReceived + intervalLost;
    const lossPercent = intervalTotal > 0 ? (intervalLost / intervalTotal) * 100 : 0;
    mon.prevPacketsLost = videoPacketsLost;
    mon.prevPacketsReceived = videoPacketsReceived;

    // Bitrate with EWMA smoothing
    const now = performance.now();
    const instantBitrate = mon.prevTimestamp > 0
      ? ((totalBytesReceived - mon.prevBytes) * 8) / ((now - mon.prevTimestamp) / 1000)
      : 0;
    mon.prevBytes = totalBytesReceived;
    mon.prevTimestamp = now;
    const alpha = 0.3;
    mon.smoothBitrate = mon.smoothBitrate === 0
      ? instantBitrate
      : alpha * instantBitrate + (1 - alpha) * mon.smoothBitrate;

    mon.stats = { rtt, packetLoss: lossPercent, bitrate: mon.smoothBitrate, codec, resolution, fps };

    // Quality classification with hysteresis
    if (rtt != null) {
      const rawQuality = classifyQuality(rtt, lossPercent, mon.quality);

      if (rawQuality === mon.candidateQuality) {
        mon.qualityCount++;
      } else {
        mon.candidateQuality = rawQuality;
        mon.qualityCount = 1;
      }

      if (mon.quality === null || mon.qualityCount >= 2) {
        if (rawQuality !== mon.quality) {
          mon.quality = rawQuality;
        }
      }
    }
  } catch {
    // Stats not available
  }
}
