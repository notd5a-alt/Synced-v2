import { useRef, useState, useEffect, useCallback } from "react";
import AudioVisualizer from "./AudioVisualizer";
import GhostAsciiArt from "./GhostAsciiArt";
import DiagnosticsPanel from "./DiagnosticsPanel";
import type { ConnectionStats, ConnectionQuality, ConnectionType, AudioProcessingState } from "../types";

interface VideoCallProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  screenStream: MediaStream | null;
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
  stats: ConnectionStats | null;
  localSpeaking: boolean;
  remoteSpeaking: boolean;
}

export default function VideoCall({
  localStream,
  remoteStream,
  screenStream,
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
  stats,
  localSpeaking,
  remoteSpeaking,
}: VideoCallProps) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const screenRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [deafened, setDeafened] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = localStream || null;
  }, [localStream]);

  useEffect(() => {
    if (remoteRef.current) {
      remoteRef.current.srcObject = localStream && remoteStream ? remoteStream : null;
    }
  }, [remoteStream, localStream]);

  const hasRemoteVideo = remoteStream
    ?.getVideoTracks()
    .some((t) => t.readyState === "live" && !t.muted);

  useEffect(() => {
    if (screenRef.current) screenRef.current.srcObject = screenStream || null;
  }, [screenStream]);

  const hasRemoteTracks = remoteStream
    ?.getTracks()
    .some((t) => t.readyState === "live" && !t.muted);

  const audioEnabled = localStream?.getAudioTracks()[0]?.enabled;
  const hasVideo = localStream?.getVideoTracks().some((t) => t.readyState === "live");
  const inCall = !!localStream;
  const isSharing = !!screenStream;

  // PiP support
  const pipSupported = typeof document !== "undefined" && "pictureInPictureEnabled" in document;

  const togglePip = useCallback(async () => {
    const video = remoteRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.error("PiP error:", err);
    }
  }, []);

  // Track PiP state changes
  useEffect(() => {
    const video = remoteRef.current;
    if (!video) return;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, []);

  // Exit PiP when call ends
  useEffect(() => {
    if (!inCall && document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
  }, [inCall]);

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

  // Track fullscreen state
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  return (
    <div className="video-call" ref={containerRef}>
      <div className="video-container">
        {/* Always-mounted for audio; hidden when no live remote video */}
        <video
          ref={remoteRef}
          className={`remote-video ${remoteSpeaking ? "speaking" : ""}`}
          autoPlay
          playsInline
          muted={deafened}
          style={{ display: hasRemoteVideo ? "block" : "none" }}
        />
        {inCall && !hasRemoteVideo && (
          <AudioVisualizer stream={remoteStream} />
        )}
        {connectionType && inCall && (
          <span className={`connection-type ${connectionType === "relay" ? "relay" : ""}`}>
            {connectionType === "relay" ? "RELAY" : "DIRECT"}
          </span>
        )}
        {connectionQuality && inCall && (
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
        {hasRemoteTracks && !hasRemoteVideo && inCall && (
          <div className={`call-status-badge ${remoteSpeaking ? "speaking" : ""}`}>
            {remoteSpeaking ? "Peer Speaking" : "Voice Call Active"}
          </div>
        )}
        {!hasRemoteTracks && !inCall && <GhostAsciiArt />}
        {!hasRemoteTracks && inCall && (
          <p className="video-placeholder">Waiting for peer to join the call...</p>
        )}
        {inCall && hasVideo && (
          <video
            ref={localRef}
            className={`local-video ${localSpeaking ? "speaking" : ""}`}
            autoPlay
            playsInline
            muted
          />
        )}
        {isSharing && (
          <video
            ref={screenRef}
            className="screen-preview"
            autoPlay
            playsInline
            muted
          />
        )}
        {showDiag && inCall && (
          <DiagnosticsPanel
            stats={stats}
            connectionQuality={connectionQuality}
            connectionType={connectionType}
          />
        )}
      </div>
      {isRecovering && <p className="call-warning">Reconnecting...</p>}
      {recoveryFailed && (
        <p className="call-error">Connection lost. Please end and restart the call.</p>
      )}
      {signalingState === "reconnecting" && (
        <p className="call-warning">Signaling reconnecting...</p>
      )}
      {callError && <p className="call-error">{callError}</p>}
      <div className="call-controls">
        {!inCall ? (
          <button
            className="btn primary"
            onClick={() => onStartCall(false)}
          >
            {hasRemoteTracks ? "Join Call" : "[ CALL ]"}
          </button>
        ) : (
          <>
            <button
              className={`btn ${audioEnabled ? "" : "muted"}`}
              onClick={onToggleAudio}
            >
              {audioEnabled ? "[ MUTE ]" : "[ UNMUTE ]"}
            </button>
            <button
              className={`btn ${deafened ? "muted" : ""}`}
              onClick={() => setDeafened((d) => !d)}
            >
              {deafened ? "[ UNDEAFEN ]" : "[ DEAFEN ]"}
            </button>
            <button
              className={`btn ${audioProcessing?.noiseSuppression ? "" : "muted"}`}
              onClick={() => onToggleAudioProcessing("noiseSuppression")}
              title="Noise Suppression"
            >
              {audioProcessing?.noiseSuppression ? "[ NS ON ]" : "[ NS OFF ]"}
            </button>
            <button
              className={`btn ${audioProcessing?.echoCancellation ? "" : "muted"}`}
              onClick={() => onToggleAudioProcessing("echoCancellation")}
              title="Echo Cancellation"
            >
              {audioProcessing?.echoCancellation ? "[ EC ON ]" : "[ EC OFF ]"}
            </button>
            <button
              className={`btn ${hasVideo ? "" : "muted"}`}
              onClick={onToggleVideo}
            >
              {hasVideo ? "[ CAM OFF ]" : "[ CAM ON ]"}
            </button>
            {!isSharing ? (
              <button className="btn" onClick={onShareScreen}>
                [ SHARE SCREEN ]
              </button>
            ) : (
              <button className="btn muted" onClick={onStopScreenShare}>
                [ STOP SHARING ]
              </button>
            )}
            {pipSupported && hasRemoteVideo && (
              <button className="btn" onClick={togglePip}>
                {isPip ? "[ EXIT PIP ]" : "[ PIP ]"}
              </button>
            )}
            <button className="btn" onClick={toggleFullscreen}>
              {isFullscreen ? "[ EXIT FS ]" : "[ FULLSCREEN ]"}
            </button>
            <button
              className={`btn ${showDiag ? "active" : ""}`}
              onClick={() => setShowDiag((d) => !d)}
            >
              [ DIAG ]
            </button>
            <button className="btn danger" onClick={onEndCall}>
              [ END CALL ]
            </button>
          </>
        )}
      </div>
    </div>
  );
}
