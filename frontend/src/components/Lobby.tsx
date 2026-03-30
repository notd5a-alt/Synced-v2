import { useState, useRef, useEffect } from "react";
import type { SignalingState, PeerMeta } from "../types";

const SPINNER_CHARS = ["|", "/", "-", "\\"];
const MAX_PEERS = 8;

interface LobbyProps {
  isHost: boolean;
  roomCode: string | null;
  connectionState: string;
  signalingState: SignalingState;
  signalingUrl: string | null;
  debugLog: string[];
  timeoutExpired: boolean;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  peerCount: number;
  roomPeers: string[];
  peerMetas: Map<string, PeerMeta>;
  localPeerId: string | null;
  displayName: string;
  localProfilePic: string;
  onRetry: () => void;
  onCancel: () => void;
}

export default function Lobby({
  isHost,
  roomCode,
  connectionState,
  signalingState,
  signalingUrl,
  debugLog,
  timeoutExpired,
  reconnectAttempt,
  maxReconnectAttempts,
  peerCount,
  roomPeers,
  peerMetas,
  localPeerId,
  displayName,
  localProfilePic,
  onRetry,
  onCancel,
}: LobbyProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [spinIdx, setSpinIdx] = useState(0);

  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  useEffect(() => {
    if (timeoutExpired) return;
    const id = setInterval(() => setSpinIdx((i) => (i + 1) % 4), 150);
    return () => clearInterval(id);
  }, [timeoutExpired]);

  const copyCode = () => {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).then(() => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  // Total participants = self + connected peers
  const totalParticipants = 1 + peerCount;

  const status = timeoutExpired
    ? "Connection timed out."
    : connectionState === "connected"
    ? "Connected!"
    : connectionState === "connecting"
    ? "Connecting..."
    : signalingState === "reconnecting"
    ? `Reconnecting to server (${reconnectAttempt}/${maxReconnectAttempts})...`
    : signalingState === "open"
    ? peerCount === 0
      ? "Waiting for peers..."
      : `${totalParticipants} peer${totalParticipants > 1 ? "s" : ""} in room`
    : signalingState === "connecting"
    ? "Connecting to server..."
    : "Initializing...";

  return (
    <div className="lobby">
      <h2>{"> "}{isHost ? "HOSTING SESSION" : "JOINING SESSION"}</h2>

      {isHost && roomCode && (
        <div className="addr-box">
          <span className="addr room-code">{roomCode.split("").join(" ")}</span>
          <button className="btn small" onClick={copyCode}>
            {copied ? "[ COPIED ]" : "[ COPY ]"}
          </button>
        </div>
      )}

      <p className="status-text">{status}</p>

      {/* Peer list */}
      {signalingState === "open" && (
        <div className="lobby-peers">
          <div className="lobby-peers-header">
            {totalParticipants} / {MAX_PEERS} peers
          </div>
          <div className="lobby-peers-list">
            {localPeerId && (
              <div className="lobby-peer-item you">
                {localProfilePic && <img src={localProfilePic} alt="" className="lobby-peer-avatar" />}
                {displayName || localPeerId.slice(0, 8)} (you)
              </div>
            )}
            {roomPeers.map((id) => {
              const meta = peerMetas.get(id);
              return (
                <div key={id} className="lobby-peer-item">
                  {meta?.avatar && <img src={meta.avatar} alt="" className="lobby-peer-avatar" />}
                  {meta?.name || id.slice(0, 8)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {timeoutExpired ? (
        <div className="lobby-actions">
          <button className="btn primary" onClick={onRetry}>
            Retry
          </button>
          <button className="btn" onClick={onCancel}>
            [ CANCEL ]
          </button>
        </div>
      ) : (
        <div className="lobby-actions">
          <span className="ascii-spinner">{SPINNER_CHARS[spinIdx]}</span>
          <button className="btn" onClick={onCancel}>
            [ CANCEL ]
          </button>
        </div>
      )}

      <div style={{
        marginTop: "2rem",
        padding: "0.75rem",
        background: "#111",
        border: "1px solid #333",
        borderRadius: "4px",
        fontSize: "0.7rem",
        fontFamily: "monospace",
        textAlign: "left",
        maxWidth: "500px",
        width: "100%",
        color: "#0f0",
      }}>
        <div style={{ marginBottom: "0.5rem", color: "#888" }}>
          // DIAG: role={isHost ? "host" : "join"} sig={signalingState} rtc={connectionState}
        </div>
        <div style={{ marginBottom: "0.5rem", color: "#888", wordBreak: "break-all" }}>
          // URL: {signalingUrl || "none"}
        </div>
        <div style={{ maxHeight: "120px", overflowY: "auto" }}>
          {debugLog.map((line, i) => {
            const lower = line.toLowerCase();
            const isError = lower.includes("error") || lower.includes("fail") || lower.includes("closed") || lower.includes("disconnected") || lower.includes("ignored");
            const isSuccess = lower.includes("connected") || lower.includes("open") || lower.includes("created") || lower.includes("sending") || lower.includes("init");
            const color = isError ? "#f55" : isSuccess ? "#6f6" : "#0f0";
            return <div key={i} style={{ color }}>{line}</div>;
          })}
        </div>
      </div>
    </div>
  );
}
