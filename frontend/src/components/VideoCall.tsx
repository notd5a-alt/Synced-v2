import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import VideoGrid from "./VideoGrid";
import GhostAsciiArt from "./GhostAsciiArt";
import DiagnosticsPanel from "./DiagnosticsPanel";
import type { ConnectionStats, ConnectionQuality, ConnectionType, AudioProcessingState } from "../types";
import type { AudioDevicesHook } from "../hooks/useAudioDevices";
import type { PeerInfo } from "../hooks/useWebRTC";
import type { PeerAudioState } from "../hooks/useMultiChat";

interface VideoCallProps {
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  streamRevision: number;
  peers: Map<string, PeerInfo>;
  peerSpeaking: Map<string, boolean>;
  peerNames: Map<string, string>;
  onStartCall: (withVideo?: boolean) => Promise<void>;
  onEndCall: () => void;
  onToggleAudio: () => void;
  onToggleVideo: () => Promise<void>;
  onShareScreen: () => Promise<void>;
  onStopScreenShare: () => Promise<void>;
  callError: string | null;
  connectionQuality: ConnectionQuality | null;
  connectionType: ConnectionType | null;
  isRecovering: boolean;
  recoveryFailed: boolean;
  signalingState: string;
  audioProcessing: AudioProcessingState;
  onToggleAudioProcessing: (key: keyof AudioProcessingState) => Promise<void>;
  aiNsEnabled: boolean;
  onToggleAiNs: () => Promise<void>;
  stats: ConnectionStats | null;
  localSpeaking: boolean;
  audioDevices: AudioDevicesHook;
  micLevel: number;
  deafened: boolean;
  onToggleDeafen: () => void;
  peersAudioState: Map<string, PeerAudioState>;
  mutedForPeers: Set<string>;
  onToggleMuteForPeer: (peerId: string) => void;
  peersMutedForMe: Map<string, boolean>;
  locallyMutedPeers: Set<string>;
  onToggleLocalMutePeer: (peerId: string) => void;
  localDisplayName?: string;
  localProfilePic?: string;
  peerAvatars?: Map<string, string>;
}

export default function VideoCall({
  localStream,
  screenStream,
  streamRevision,
  peers,
  peerSpeaking,
  peerNames,
  onStartCall,
  onEndCall,
  onToggleAudio,
  onToggleVideo,
  onShareScreen,
  onStopScreenShare,
  callError,
  connectionQuality,
  connectionType,
  isRecovering,
  recoveryFailed,
  signalingState,
  audioProcessing,
  onToggleAudioProcessing,
  aiNsEnabled,
  onToggleAiNs,
  stats,
  localSpeaking,
  audioDevices,
  micLevel,
  deafened,
  onToggleDeafen,
  peersAudioState,
  mutedForPeers,
  onToggleMuteForPeer,
  peersMutedForMe,
  locallyMutedPeers,
  onToggleLocalMutePeer,
  localDisplayName,
  localProfilePic,
  peerAvatars,
}: VideoCallProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiag, setShowDiag] = useState(false);
  const [showDevices, setShowDevices] = useState(false);

  const audioEnabled = localStream?.getAudioTracks()[0]?.enabled;
  const hasVideo = localStream?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted);
  const inCall = !!localStream;
  const isSharing = !!screenStream;

  // Derive whether any remote peer has live tracks (for pre-call state)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hasRemoteTracks = useMemo(() => {
    for (const [, peer] of peers) {
      if (peer.remoteStream.getTracks().some((t) => t.readyState === "live" && !t.muted)) return true;
      if (peer.remoteScreenStream.getVideoTracks().some((t) => t.readyState === "live" && !t.muted)) return true;
    }
    return false;
  }, [peers, streamRevision]);

  // Fullscreen support
  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await el.requestFullscreen();
      }
    } catch (err) {
      console.error("Fullscreen error:", err);
    }
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  return (
    <div className="video-call" ref={containerRef}>
      <div className="video-container">
        {inCall ? (
          <>
            <VideoGrid
              localStream={localStream}
              localSpeaking={localSpeaking}
              localHasVideo={!!hasVideo}
              screenStream={screenStream}
              peers={peers}
              peerSpeaking={peerSpeaking}
              peerNames={peerNames}
              peersAudioState={peersAudioState}
              mutedForPeers={mutedForPeers}
              onToggleMuteForPeer={onToggleMuteForPeer}
              peersMutedForMe={peersMutedForMe}
              locallyMutedPeers={locallyMutedPeers}
              onToggleLocalMutePeer={onToggleLocalMutePeer}
              streamRevision={streamRevision}
              localDisplayName={localDisplayName}
              localProfilePic={localProfilePic}
              peerAvatars={peerAvatars}
            />
            {connectionType && (
              <span className={`connection-type ${connectionType === "relay" ? "relay" : ""}`}>
                {connectionType === "relay" ? "RELAY" : "DIRECT"}
              </span>
            )}
            {connectionQuality && (
              <span className={`quality-badge quality-${connectionQuality}`}>
                {connectionQuality === "excellent"
                  ? "HD"
                  : connectionQuality === "good"
                  ? "Good"
                  : connectionQuality === "poor"
                  ? "Poor"
                  : "Bad"}
              </span>
            )}
          </>
        ) : (
          <>
            {hasRemoteTracks ? (
              <p className="video-placeholder">Peer is in a call. Click JOIN to connect.</p>
            ) : (
              <GhostAsciiArt />
            )}
          </>
        )}
        {showDiag && inCall && (
          <DiagnosticsPanel
            stats={stats}
            connectionQuality={connectionQuality}
            connectionType={connectionType}
          />
        )}
      </div>
      {isRecovering && <p className="call-warning" role="status" aria-live="polite">Reconnecting...</p>}
      {recoveryFailed && (
        <p className="call-error" role="status" aria-live="polite">Connection lost. Please end and restart the call.</p>
      )}
      {signalingState === "reconnecting" && (
        <p className="call-warning" role="status" aria-live="polite">Signaling reconnecting...</p>
      )}
      {callError && <p className="call-error" role="status" aria-live="polite">{callError}</p>}
      {showDevices && inCall && (
        <div className="device-selector-panel">
          <div className="device-selector-row">
            <label className="device-label">MIC:</label>
            <select
              className="device-select"
              value={audioDevices.selectedInput}
              onChange={(e) => audioDevices.setInputDevice(e.target.value)}
            >
              {audioDevices.inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
            <div className="mic-level-bar">
              <div
                className="mic-level-fill"
                style={{ width: `${micLevel}%` }}
              />
            </div>
          </div>
          <div className="device-selector-row">
            <label className="device-label">OUT:</label>
            <select
              className="device-select"
              value={audioDevices.selectedOutput}
              onChange={(e) => audioDevices.setOutputDevice(e.target.value)}
            >
              {audioDevices.outputDevices.length === 0 ? (
                <option value="">Default</option>
              ) : (
                audioDevices.outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      )}
      <div className="call-controls">
        {!inCall ? (
          <div className="controls-center">
            <button
              className="btn primary"
              onClick={() => onStartCall(false)}
              aria-label={hasRemoteTracks ? "Join call" : "Start call"}
            >
              {hasRemoteTracks ? "[ JOIN CALL ]" : "[ CALL ]"}
            </button>
          </div>
        ) : (
          <>
            <div className="controls-left">
              <button
                className={`btn ${audioEnabled ? "" : "muted"}`}
                onClick={onToggleAudio}
                aria-label={audioEnabled ? "Mute microphone" : "Unmute microphone"}
              >
                {audioEnabled ? "[ MIC ON ]" : "[ MIC OFF ]"}
              </button>
              <button
                className={`btn ${deafened ? "muted" : ""}`}
                onClick={onToggleDeafen}
                aria-label={deafened ? "Undeafen" : "Deafen"}
              >
                {deafened ? "[ UNDEAFEN ]" : "[ DEAFEN ]"}
              </button>
              <button
                className={`btn ${audioProcessing?.echoCancellation ? "" : "muted"}`}
                onClick={() => onToggleAudioProcessing("echoCancellation")}
                aria-label={audioProcessing?.echoCancellation ? "Disable echo cancellation" : "Enable echo cancellation"}
              >
                {audioProcessing?.echoCancellation ? "[ EC ON ]" : "[ EC OFF ]"}
              </button>
              <button
                className={`btn ${aiNsEnabled ? "active" : "muted"}`}
                onClick={onToggleAiNs}
                title="AI Noise Suppression (RNNoise neural network)"
                aria-label={aiNsEnabled ? "Disable AI noise suppression" : "Enable AI noise suppression"}
              >
                {aiNsEnabled ? "[ AI NS ON ]" : "[ AI NS ]"}
              </button>
              <button
                className={`btn ${showDevices ? "active" : ""}`}
                onClick={() => setShowDevices((d) => !d)}
                aria-label="Toggle audio device settings"
              >
                [ DEVICES ]
              </button>
            </div>
            <div className="controls-center">
              <button
                className={`btn ${hasVideo ? "active" : "muted"}`}
                onClick={onToggleVideo}
                aria-label={hasVideo ? "Turn off camera" : "Turn on camera"}
              >
                {hasVideo ? "[ CAM ON ]" : "[ CAM OFF ]"}
              </button>
              {!isSharing ? (
                <button className="btn" onClick={onShareScreen} aria-label="Share screen">
                  [ SHARE ]
                </button>
              ) : (
                <button className="btn muted" onClick={onStopScreenShare} aria-label="Stop sharing screen">
                  [ STOP SHARE ]
                </button>
              )}
              <button className="btn" onClick={toggleFullscreen} aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
                {isFullscreen ? "[ EXIT FS ]" : "[ FULLSCREEN ]"}
              </button>
            </div>
            <div className="controls-right">
              <button
                className={`btn ${showDiag ? "active" : ""}`}
                onClick={() => setShowDiag((d) => !d)}
                aria-label="Toggle diagnostics panel"
              >
                [ DIAG ]
              </button>
              <button className="btn danger" onClick={onEndCall} aria-label="End call">
                [ END CALL ]
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
