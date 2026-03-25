import { useRef, useState, useEffect, useCallback } from "react";

const ICE_RESTART_DELAY = 15000; // wait 15s on "disconnected" before restarting
const MAX_RESTART_ATTEMPTS = 3;
const CONNECTION_TIMEOUT = 30000; // 30s to establish initial connection
const STATS_INTERVAL = 3000; // poll stats every 3s

export default function useConnectionMonitor(pcRef, signalingState, connectionState) {
  const [connectionQuality, setConnectionQuality] = useState(null);
  const [stats, setStats] = useState(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [timeoutExpired, setTimeoutExpired] = useState(false);

  const restartAttemptsRef = useRef(0);
  const disconnectTimerRef = useRef(null);
  const timeoutTimerRef = useRef(null);
  const statsIntervalRef = useRef(null);
  const prevBytesRef = useRef(0);
  const prevTimestampRef = useRef(0);
  const signalingStateRef = useRef(signalingState);
  signalingStateRef.current = signalingState;

  const clearTimers = useCallback(() => {
    clearTimeout(disconnectTimerRef.current);
    clearTimeout(timeoutTimerRef.current);
    clearInterval(statsIntervalRef.current);
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
      clearTimeout(disconnectTimerRef.current);
      clearTimeout(timeoutTimerRef.current);
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
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
      attemptRestart();
    } else if (connectionState === "closed" || connectionState === "new") {
      clearTimers();
      setConnectionQuality(null);
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
      clearTimeout(timeoutTimerRef.current);
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
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
      return;
    }

    const pollStats = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let rtt = null;
        let packetsLost = 0;
        let packetsReceived = 0;
        let bytesReceived = 0;

        report.forEach((stat) => {
          if (stat.type === "candidate-pair" && stat.state === "succeeded") {
            rtt = stat.currentRoundTripTime != null
              ? stat.currentRoundTripTime * 1000
              : rtt;
          }
          if (stat.type === "inbound-rtp" && stat.kind === "audio") {
            packetsLost += stat.packetsLost || 0;
            packetsReceived += stat.packetsReceived || 0;
            bytesReceived += stat.bytesReceived || 0;
          }
        });

        const totalPackets = packetsReceived + packetsLost;
        const lossPercent = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

        const now = performance.now();
        const bitrate = prevTimestampRef.current > 0
          ? ((bytesReceived - prevBytesRef.current) * 8) / ((now - prevTimestampRef.current) / 1000)
          : 0;
        prevBytesRef.current = bytesReceived;
        prevTimestampRef.current = now;

        setStats({ rtt, packetLoss: lossPercent, bitrate });

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
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    };
  }, [connectionState, pcRef]);

  // Cleanup on unmount
  useEffect(() => {
    return clearTimers;
  }, [clearTimers]);

  return {
    connectionQuality,
    stats,
    isRecovering,
    recoveryFailed,
    timeoutExpired,
    setTimeoutExpired,
  };
}
