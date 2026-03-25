import { useState, useRef, useEffect } from "react";

const SPINNER_CHARS = ["|", "/", "-", "\\"];

export default function Lobby({
  isHost,
  hostAddr,
  connectionState,
  signalingState,
  timeoutExpired,
  onRetry,
  onCancel,
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);
  const [spinIdx, setSpinIdx] = useState(0);

  useEffect(() => {
    return () => clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    if (timeoutExpired) return;
    const id = setInterval(() => setSpinIdx((i) => (i + 1) % 4), 150);
    return () => clearInterval(id);
  }, [timeoutExpired]);

  const copyAddr = () => {
    navigator.clipboard.writeText(hostAddr).then(() => {
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  };

  const status = timeoutExpired
    ? "Connection timed out."
    : connectionState === "connected"
    ? "Connected!"
    : connectionState === "connecting"
    ? "Connecting..."
    : signalingState === "reconnecting"
    ? "Reconnecting to server..."
    : signalingState === "open"
    ? "Waiting for peer..."
    : signalingState === "connecting"
    ? "Connecting to host..."
    : "Initializing...";

  return (
    <div className="lobby">
      <h2>{"> "}{isHost ? "HOSTING SESSION" : "JOINING SESSION"}</h2>

      {isHost && hostAddr && (
        <div className="addr-box">
          <span className="addr">{hostAddr}</span>
          <button className="btn small" onClick={copyAddr}>
            {copied ? "[ COPIED ]" : "[ COPY ]"}
          </button>
        </div>
      )}

      <p className="status-text">{status}</p>

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
        <span className="ascii-spinner">{SPINNER_CHARS[spinIdx]}</span>
      )}
    </div>
  );
}
