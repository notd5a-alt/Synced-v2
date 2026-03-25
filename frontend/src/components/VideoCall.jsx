import { useRef, useState, useEffect } from "react";
import AudioVisualizer from "./AudioVisualizer";

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
  isRecovering,
  recoveryFailed,
  signalingState,
}) {
  const localRef = useRef(null);
  const remoteRef = useRef(null);
  const screenRef = useRef(null);
  const [deafened, setDeafened] = useState(false);

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

  return (
    <div className="video-call">
      <div className="video-container">
        {/* Always-mounted for audio; hidden when no live remote video */}
        <video
          ref={remoteRef}
          className="remote-video"
          autoPlay
          playsInline
          muted={deafened}
          style={{ display: hasRemoteVideo ? "block" : "none" }}
        />
        {inCall && !hasRemoteVideo && (
          <AudioVisualizer stream={remoteStream} />
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
          <div className="call-status-badge">Voice Call Active</div>
        )}
        {!hasRemoteTracks && !inCall && (
          <p className="video-placeholder">Start a voice or video call</p>
        )}
        {!hasRemoteTracks && inCall && (
          <p className="video-placeholder">Waiting for peer to join the call...</p>
        )}
        {inCall && hasVideo && (
          <video
            ref={localRef}
            className="local-video"
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
            <button className="btn danger" onClick={onEndCall}>
              [ END CALL ]
            </button>
          </>
        )}
      </div>
    </div>
  );
}
