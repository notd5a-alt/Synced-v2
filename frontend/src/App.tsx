import { useState, useCallback, useEffect, useRef } from "react";
import useSignaling from "./hooks/useSignaling";
import useWebRTC from "./hooks/useWebRTC";
import useConnectionMonitor from "./hooks/useConnectionMonitor";
import useMultiChat from "./hooks/useMultiChat";
import useMultiFileTransfer from "./hooks/useMultiFileTransfer";
import useNoiseSuppression, { preloadRnnoise } from "./hooks/useNoiseSuppression";
import useMultiVAD from "./hooks/useMultiVAD";
import useTheme from "./hooks/useTheme";
import useAudioDevices from "./hooks/useAudioDevices";
import useMicLevel from "./hooks/useMicLevel";
import useAppState from "./hooks/useAppState";
import type { FullResetCleanups } from "./hooks/useAppState";
import Home from "./components/Home";
import Lobby from "./components/Lobby";
import Chat from "./components/Chat";
import VideoCall from "./components/VideoCall";
import FileShare from "./components/FileShare";
import ErrorBoundary from "./components/ErrorBoundary";
import ThemeSelector from "./components/ThemeSelector";
import { playPeerConnected, playPeerDisconnected, warmUpAudio, preloadRingtone, startRingtone, stopRingtone } from "./utils/sounds";
import { getApiBaseUrl, getWsBaseUrl } from "./config";
import type { PresenceStatus } from "./types";
import "./styles/index.css";

type Tab = "chat" | "video" | "files";

export default function App() {
  const app = useAppState();

  const signaling = useSignaling(app.sigUrl);
  const isHost = app.mode === "host";
  const webrtc = useWebRTC(signaling);
  const theme = useTheme();
  const monitor = useConnectionMonitor(webrtc.peers, signaling.state);
  const chat = useMultiChat(webrtc.peers, app.displayName, app.profilePic);
  const files = useMultiFileTransfer(webrtc.peers);
  const vad = useMultiVAD(webrtc.localStream, webrtc.peers);
  const remoteAudioRef = useRef<HTMLVideoElement | null>(null);
  const persistentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioDevices = useAudioDevices(
    webrtc.localStreamRef,
    webrtc.pcRef,
    remoteAudioRef,
    webrtc.setLocalStream,
    webrtc.localStream,
  );
  const micLevel = useMicLevel(webrtc.localStream);
  const noiseSuppression = useNoiseSuppression();

  // Legacy persistent audio element exists only for useAudioDevices setSinkId.
  // Actual multi-peer audio is handled by PeerAudio components — do NOT set
  // srcObject here, as that would create a second audio path that bypasses
  // per-peer local muting.

  // Stable cleanup callbacks for fullReset
  const resetCleanups = useRef<FullResetCleanups>({
    cleanupNoiseSuppression: noiseSuppression.teardown,
    cleanupWebRTC: webrtc.cleanup,
    clearPersistentAudio: () => {
      if (persistentAudioRef.current) {
        persistentAudioRef.current.srcObject = null;
      }
    },
    disconnectSignaling: signaling.disconnect,
    clearChatMessages: chat.clearMessages,
  });
  resetCleanups.current = {
    cleanupNoiseSuppression: noiseSuppression.teardown,
    cleanupWebRTC: webrtc.cleanup,
    clearPersistentAudio: () => {
      if (persistentAudioRef.current) {
        persistentAudioRef.current.srcObject = null;
      }
    },
    disconnectSignaling: signaling.disconnect,
    clearChatMessages: chat.clearMessages,
  };

  // Full state reset — shared by handleDisconnect and peer-disconnect effect.
  // Idempotent: webrtc.cleanup() no-ops if PC is already null.
  const fullReset = useCallback(() => {
    app.fullReset(resetCleanups.current);
  }, [app.fullReset]);

  // Animated screen transition to session once any peer connects
  const prevPeerCountRef = useRef(0);
  useEffect(() => {
    if (webrtc.peerCount > 0 && app.screen === "lobby") {
      app.changeScreen("session");
      app.setFingerprint(webrtc.getFingerprint());
      playPeerConnected();
    }
    // Play sound when a new peer joins mid-session
    if (app.screen === "session" && webrtc.peerCount > prevPeerCountRef.current && prevPeerCountRef.current > 0) {
      playPeerConnected();
    }
    // Play sound when a peer leaves (but session continues if others remain)
    if (app.screen === "session" && webrtc.peerCount < prevPeerCountRef.current && webrtc.peerCount > 0) {
      playPeerDisconnected();
    }
    prevPeerCountRef.current = webrtc.peerCount;
  }, [webrtc.peerCount, app.screen, webrtc.getFingerprint, app.changeScreen, app.setFingerprint]);

  // Handle all peers gone during session — return to home
  useEffect(() => {
    if (app.screen === "session" && webrtc.peerCount === 0) {
      // All peers disconnected — only reset if we were previously connected
      // (prevPeerCountRef > 0 means we had peers, now they're all gone)
      if (prevPeerCountRef.current > 0 || webrtc.connectionState === "new") {
        playPeerDisconnected();
        fullReset();
      }
    }
  }, [webrtc.peerCount, webrtc.connectionState, app.screen, fullReset]);

  // Note: display name and profile pic are sent automatically by useMultiChat
  // when channels open and when values change mid-session.
  // Signaling-level metadata (for lobby/API) is sent on connect and on change.
  useEffect(() => {
    if (signaling.state === "open" && (app.displayName || app.profilePic)) {
      signaling.send({ type: "set-meta", name: app.displayName, avatar: app.profilePic });
    }
  }, [app.displayName, app.profilePic, signaling.state, signaling.send]);

  const wsProto = window.location.protocol === "https:" ? "wss" : "ws";

  // Pre-load ringtone audio on mount
  useEffect(() => {
    preloadRingtone();
  }, []);

  // Lazy-load RNNoise WASM only when user opens the Call tab
  useEffect(() => {
    if (app.activeTab === "video") {
      preloadRnnoise();
    }
  }, [app.activeTab]);

  // Auto-enable AI noise suppression once when a call starts
  useEffect(() => {
    if (app.nsAutoEnabledRef.current || noiseSuppression.enabled || !webrtc.localStream) return;
    app.nsAutoEnabledRef.current = true;
    const track = webrtc.localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      noiseSuppression.toggle(track, webrtc.pcRef, webrtc.localStreamRef).then((newTrack) => {
        if (newTrack) {
          webrtc.setLocalStream((s) => s ? new MediaStream(s.getTracks()) : s);
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtc.localStream]);

  const handleCreateRoom = useCallback(async () => {
    // Defensive: tear down any leftover state from a previous session
    fullReset();
    warmUpAudio();
    app.setMode("host");
    app.setRoomError(null);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/rooms`, { method: "POST" });
      if (!res.ok) throw new Error("Server at capacity");
      const { room_code, token } = await res.json();
      app.setRoomCode(room_code);
      const wsUrl = `${getWsBaseUrl()}/ws/${room_code}?token=${encodeURIComponent(token)}`;
      app.setSigUrl(wsUrl);
      app.changeScreen("lobby");
    } catch (err) {
      app.setRoomError(err instanceof Error ? err.message : "Failed to create room");
      app.setMode(null);
    }
  }, [fullReset, app.changeScreen, app.setMode, app.setRoomError, app.setRoomCode, app.setSigUrl]);

  const handleJoinRoom = useCallback(async (code: string) => {
    // Defensive: tear down any leftover state from a previous session
    fullReset();
    warmUpAudio();
    app.setMode("join");
    app.setRoomError(null);
    const upper = code.toUpperCase().trim();

    // Backward compat: if contains ":", treat as IP:port (old direct-connect flow)
    if (upper.includes(":")) {
      const proto = upper === window.location.host ? wsProto : "ws";
      app.setSigUrl(`${proto}://${upper}/ws`);
      app.changeScreen("lobby");
      return;
    }

    // Validate room code format before any network calls (URL safety + enumeration defense)
    if (!/^[A-HJKL-NP-Z2-9]{6}$/.test(upper)) {
      app.setRoomError("Invalid room code. Codes are 6 characters (letters and numbers).");
      app.setMode(null);
      return;
    }

    let roomToken = "";
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/rooms/${upper}`);
      const data = await res.json();
      if (!data.exists) {
        app.setRoomError("Room not found. Check the code and try again.");
        app.setMode(null);
        return;
      }
      if (!data.joinable) {
        app.setRoomError("Room is full.");
        app.setMode(null);
        return;
      }
      roomToken = data.token || "";
    } catch {
      app.setRoomError("Could not reach signaling server.");
      app.setMode(null);
      return;
    }

    app.setRoomCode(upper);
    app.setSigUrl(`${getWsBaseUrl()}/ws/${upper}?token=${encodeURIComponent(roomToken)}`);
    app.changeScreen("lobby");
  }, [fullReset, wsProto, app.changeScreen, app.setMode, app.setRoomError, app.setRoomCode, app.setSigUrl]);

  // Connect signaling once URL is set (only once per sigUrl to avoid infinite reconnect loop)
  useEffect(() => {
    if (app.sigUrl && signaling.state === "closed" && !app.sigConnectedRef.current) {
      app.sigConnectedRef.current = true;
      signaling.connect();
    }
    if (!app.sigUrl) {
      app.sigConnectedRef.current = false;
    }
  }, [app.sigUrl, signaling.state, signaling.connect, app.sigConnectedRef]);

  // Init WebRTC once signaling is open — fetch ICE config from backend first.
  // Only fires when signaling.state transitions to "open" (initial connect or
  // reconnect after disconnect). handleRetry() calls init() directly for retries.
  useEffect(() => {
    if (signaling.state === "open") {
      // Note: signaling-level metadata (set-meta) is sent by the effect
      // that watches displayName/profilePic changes — no need to duplicate here.

      let cancelled = false;
      signaling.addLog("effect: init");
      fetch(`${getApiBaseUrl()}/api/ice-config`)
        .then((r) => r.json())
        .then((config) => { if (!cancelled) webrtc.init(config); })
        .catch(() => { if (!cancelled) webrtc.init(null); });
      return () => { cancelled = true; };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signaling.state, webrtc.init, signaling.addLog]);

  // Ringtone logic — plays for both caller (ringback) and receiver (incoming)
  // Check all peers for live remote tracks
  let hasRemoteTracks = false;
  for (const [, peer] of webrtc.peers) {
    if (peer.remoteStream.getTracks().some((t) => t.readyState === "live" && !t.muted)) {
      hasRemoteTracks = true;
      break;
    }
  }
  const wasInCallRef = useRef(false);
  const [callRejected, setCallRejected] = useState(false);
  const peerEverJoinedCallRef = useRef(false);

  useEffect(() => {
    if (webrtc.localStream) {
      wasInCallRef.current = true;
    }
  }, [webrtc.localStream]);

  // Track whether the remote peer ever answered (prevents ringtone after mid-call hangup)
  useEffect(() => {
    if (hasRemoteTracks && webrtc.localStream) {
      peerEverJoinedCallRef.current = true;
    }
    if (!webrtc.localStream) {
      peerEverJoinedCallRef.current = false;
    }
  }, [hasRemoteTracks, webrtc.localStream]);

  // Reset when remote tracks disappear (peer ended their call)
  useEffect(() => {
    if (!hasRemoteTracks) {
      wasInCallRef.current = false;
      setCallRejected(false);
    }
  }, [hasRemoteTracks]);

  const incomingCall = hasRemoteTracks && !webrtc.localStream && !wasInCallRef.current && !callRejected;
  const outgoingRinging = app.screen === "session"
    && !!webrtc.localStream
    && !hasRemoteTracks
    && !peerEverJoinedCallRef.current;
  const ringing = incomingCall || outgoingRinging;

  useEffect(() => {
    if (ringing) {
      startRingtone();
      return () => stopRingtone();
    }
  }, [ringing]);

  // Unread message notification when not on chat tab
  const unreadCount = chat.peerMsgSeq - app.lastSeenSeq;

  // Mark all as read when switching to chat tab
  useEffect(() => {
    if (app.activeTab === "chat") {
      app.setLastSeenSeq(chat.peerMsgSeq);
      app.setUnreadDismissed(false);
    }
  }, [app.activeTab, chat.peerMsgSeq, app.setLastSeenSeq, app.setUnreadDismissed]);

  // Reset dismissed flag when new messages arrive after dismiss
  useEffect(() => {
    if (unreadCount > 0 && app.unreadDismissed) {
      app.setUnreadDismissed(false);
    }
  }, [chat.peerMsgSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasUnread = unreadCount > 0 && app.activeTab !== "chat" && !app.unreadDismissed;

  // Presence detection: online / idle / away
  const presenceRef = useRef<PresenceStatus>("online");
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (app.screen !== "session") return;

    const sendIfChanged = (status: PresenceStatus) => {
      if (presenceRef.current !== status) {
        presenceRef.current = status;
        chat.sendPresence(status);
      }
    };

    const resetIdle = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (document.visibilityState === "visible") {
        sendIfChanged("online");
        idleTimerRef.current = setTimeout(() => sendIfChanged("idle"), 60000);
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        sendIfChanged("away");
      } else {
        resetIdle();
      }
    };

    const handleActivity = () => resetIdle();

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleActivity);
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);

    // Send initial online status
    chat.sendPresence("online");
    resetIdle();

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleActivity);
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
    };
  }, [app.screen, chat.sendPresence, webrtc.chatChannel]);

  // Command palette — handles /slash commands from chat input
  const [cmdOutput, setCmdOutput] = useState<string | null>(null);
  const cmdOutputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCommand = useCallback((cmd: string) => {
    const parts = cmd.trim().split(/\s+/);
    const name = parts[0].toLowerCase();
    let output: string | null = null;

    switch (name) {
      case "/clear":
        chat.clearMessages();
        output = "Messages cleared.";
        break;
      case "/fingerprint":
        output = app.fingerprint
          ? `DTLS Fingerprint:\n${app.fingerprint}`
          : "No fingerprint available (not connected).";
        break;
      case "/diag":
        app.setActiveTab("video");
        output = "Switched to Call tab. Click [ DIAG ] to view diagnostics.";
        break;
      case "/stats": {
        const s = monitor.stats;
        output = s
          ? `RTT: ${s.rtt != null ? Math.round(s.rtt) + "ms" : "--"}\nLoss: ${s.packetLoss != null ? s.packetLoss.toFixed(1) + "%" : "--"}\nBitrate: ${s.bitrate != null ? Math.round(s.bitrate / 1000) + " kbps" : "--"}\nQuality: ${monitor.connectionQuality || "--"}\nType: ${monitor.connectionType || "--"}`
          : "No stats available (not in a call).";
        break;
      }
      case "/whoami":
        output = `Role: ${isHost ? "HOST" : "JOINER"}\nPeer presence: ${chat.peerPresence || "unknown"}`;
        break;
      case "/theme": {
        const themeName = parts[1]?.toLowerCase();
        if (themeName) {
          const found = theme.themes.find((t) => t.id === themeName || t.name.toLowerCase() === themeName);
          if (found) {
            theme.setTheme(found.id);
            output = `Theme set to: ${found.name}`;
          } else {
            output = `Unknown theme: ${themeName}\nAvailable: ${theme.themes.map((t) => t.id).join(", ")}`;
          }
        } else {
          output = `Current theme: ${theme.themeId}\nAvailable: ${theme.themes.map((t) => t.id).join(", ")}\nUsage: /theme <name>`;
        }
        break;
      }
      case "/help":
        output = [
          "Available commands:",
          "  /clear        — Clear chat messages",
          "  /fingerprint  — Show DTLS fingerprint",
          "  /diag         — Open diagnostics panel",
          "  /stats        — Show connection stats",
          "  /whoami       — Show your role and peer status",
          "  /theme [name] — Change color theme",
          "  /help         — Show this help",
        ].join("\n");
        break;
      default:
        output = `Unknown command: ${name}\nType /help for available commands.`;
    }

    if (output) {
      setCmdOutput(output);
      if (cmdOutputTimerRef.current) clearTimeout(cmdOutputTimerRef.current);
      cmdOutputTimerRef.current = setTimeout(() => setCmdOutput(null), 8000);
    }
  }, [app.fingerprint, app.setActiveTab, monitor.stats, monitor.connectionQuality, monitor.connectionType, isHost, chat.peerPresence, chat.clearMessages, theme]);

  const handleDisconnect = useCallback(() => {
    fullReset();
  }, [fullReset]);

  const handleRetry = useCallback(() => {
    webrtc.cleanup();
    monitor.setTimeoutExpired(false);
    // Re-init will be triggered by the signaling.state === "open" effect
    fetch(`${getApiBaseUrl()}/api/ice-config`)
      .then((r) => r.json())
      .then((config) => webrtc.init(config))
      .catch(() => webrtc.init(null));
  }, [webrtc.cleanup, webrtc.init, monitor.setTimeoutExpired]);

  if (app.screen === "home") {
    return <div className={app.screenClass}><Home onCreateRoom={handleCreateRoom} onJoinRoom={handleJoinRoom} roomError={app.roomError} themeId={theme.themeId} onThemeChange={theme.setTheme} canvasBgId={theme.canvasBgId} onCanvasBgChange={theme.setCanvasBg} uiScale={theme.uiScale} onUiScaleChange={theme.setUiScale} displayName={app.displayName} onDisplayNameChange={app.setDisplayName} profilePic={app.profilePic} onProfilePicChange={app.setProfilePic} /></div>;
  }

  if (app.screen === "lobby") {
    return (
      <div className={app.screenClass}><Lobby
        isHost={isHost}
        roomCode={app.roomCode}
        connectionState={webrtc.connectionState}
        signalingState={signaling.state}
        signalingUrl={app.sigUrl}
        debugLog={signaling.debugLog}
        timeoutExpired={monitor.timeoutExpired}
        reconnectAttempt={signaling.reconnectAttempt}
        maxReconnectAttempts={signaling.maxReconnectAttempts}
        peerCount={webrtc.peerCount}
        roomPeers={signaling.roomPeers}
        peerMetas={signaling.peerMetas}
        localPeerId={signaling.peerId}
        displayName={app.displayName}
        localProfilePic={app.profilePic}
        onRetry={handleRetry}
        onCancel={handleDisconnect}
      /></div>
    );
  }

  return (
    <div className={`session ${app.screenClass}`}>
      <header className="session-header">
        <img src="/logo.png" alt="Synced" className="header-logo" />
        <span className="brand">{"> "}SYNCED</span>
        <span className="peer-count" title={`${webrtc.peerCount + 1} participants in room`}>
          [{webrtc.peerCount + 1}/8]
        </span>
        {chat.peerPresence && (
          <span className={`presence-indicator ${chat.peerPresence}`} role="status" aria-label={`Peer is ${chat.peerPresence}`}>
            <span className="presence-dot" aria-hidden="true" />
            {chat.peerPresence !== "online" && chat.peerPresence.toUpperCase()}
          </span>
        )}
        {app.fingerprint && (
          <span className="fingerprint" title="DTLS fingerprint — verify with your peer">
            {app.fingerprint.slice(0, 20)}...
          </span>
        )}
        {app.roomCode && (
          <span className="room-code-badge" title="Room code — share with peers to join">
            ROOM: {app.roomCode}
            <button
              className="copy-room-code"
              onClick={() => {
                navigator.clipboard.writeText(app.roomCode!);
              }}
              title="Copy room code"
            >
              ⧉
            </button>
          </span>
        )}
        <nav className="tabs">
          <button
            className={app.activeTab === "chat" ? "active" : ""}
            onClick={() => app.setActiveTab("chat")}
          >
            Chat{unreadCount > 0 && app.activeTab !== "chat" && (
              <span className="tab-badge">{unreadCount}</span>
            )}
          </button>
          <button
            className={app.activeTab === "video" ? "active" : ""}
            onClick={() => app.setActiveTab("video")}
          >
            Call
          </button>
          <button
            className={app.activeTab === "files" ? "active" : ""}
            onClick={() => app.setActiveTab("files")}
          >
            Files
          </button>
        </nav>
        <button
          className={`btn small ${app.showThemePanel ? "active" : ""}`}
          onClick={() => app.setShowThemePanel((s) => !s)}
        >
          [ STYLE ]
        </button>
        <button className="btn small danger" onClick={handleDisconnect}>
          [ DISCONNECT ]
        </button>
      </header>

      {app.showThemePanel && (
        <div className="theme-panel">
          <ThemeSelector currentTheme={theme.themeId} onSelect={theme.setTheme} currentCanvasBg={theme.canvasBgId} onCanvasBgSelect={theme.setCanvasBg} currentScale={theme.uiScale} onScaleSelect={theme.setUiScale} />
        </div>
      )}

      {incomingCall && (
        <div className="incoming-call-pill">
          <span className="pill-pulse" />
          <span className="pill-text">INCOMING CALL</span>
          <button
            className="btn small primary"
            onClick={() => {
              app.setActiveTab("video");
              webrtc.startCall(false);
            }}
          >
            [ JOIN ]
          </button>
          <button
            className="btn small pill-reject"
            onClick={() => setCallRejected(true)}
          >
            [ REJECT ]
          </button>
        </div>
      )}

      {hasUnread && (
        <div className="incoming-call-pill message-pill">
          <span className="pill-pulse message-pulse" />
          <span className="pill-text">NEW MESSAGE{unreadCount > 1 ? `S (${unreadCount})` : ""}</span>
          <button
            className="btn small primary"
            onClick={() => app.setActiveTab("chat")}
          >
            [ VIEW ]
          </button>
          <button
            className="btn small pill-dismiss"
            onClick={() => { app.setUnreadDismissed(true); app.setLastSeenSeq(chat.peerMsgSeq); }}
          >
            [ DISMISS ]
          </button>
        </div>
      )}

      {/* Persistent audio elements — one per peer, stays mounted across tab switches
           so call audio continues regardless of which tab is active. VideoGrid's
           <video> elements are always muted; these are the sole audio output path. */}
      {webrtc.localStream && Array.from(webrtc.peers.values()).map((peer) => (
        <PeerAudio
          key={peer.peerId}
          stream={peer.remoteStream}
          muted={app.deafened || app.locallyMutedPeers.has(peer.peerId)}
        />
      ))}
      {/* Legacy ref for useAudioDevices setSinkId — no srcObject, just a target for output device */}
      <audio ref={persistentAudioRef} style={{ display: "none" }} />

      <main className="session-content">
        {app.activeTab === "chat" && (
          <div className="tab-content" key="chat">
          <ErrorBoundary fallback="tab">
          <Chat
            messages={chat.messages}
            onSend={chat.sendMessage}
            onCommand={handleCommand}
            cmdOutput={cmdOutput}
            onReaction={chat.sendReaction}
            onMarkRead={chat.sendReadReceipt}
            onTyping={chat.sendTyping}
            peerReadUpTo={chat.peerReadUpTo}
            peerTyping={chat.peerTyping}
            peerNames={chat.peerNames}
            peerAvatars={chat.peerAvatars}
            localProfilePic={app.profilePic}
            onSendImage={chat.sendImage}
            onSendVoice={chat.sendVoice}
            localStream={webrtc.localStream}
          />
          </ErrorBoundary>
          </div>
        )}
        {app.activeTab === "video" && (
          <div className="tab-content" key="video">
          <ErrorBoundary fallback="tab">
          <VideoCall
            localStream={webrtc.localStream}
            screenStream={webrtc.screenStream}
            streamRevision={webrtc.streamRevision}
            peers={webrtc.peers}
            peerSpeaking={vad.peerSpeaking}
            peerNames={chat.peerNames}
            onStartCall={webrtc.startCall}
            onEndCall={webrtc.endCall}
            onToggleAudio={() => {
              webrtc.toggleAudio();
              // Broadcast new mute state — after toggle, track.enabled is the new state
              const track = webrtc.localStreamRef.current?.getAudioTracks()[0];
              const muted = track ? !track.enabled : true;
              chat.sendAudioState(muted, app.deafened);
            }}
            onToggleVideo={webrtc.toggleVideo}
            onShareScreen={webrtc.shareScreen}
            onStopScreenShare={webrtc.stopScreenShare}
            callError={webrtc.callError}
            connectionQuality={monitor.connectionQuality}
            connectionType={monitor.connectionType}
            isRecovering={monitor.isRecovering}
            recoveryFailed={monitor.recoveryFailed}
            signalingState={signaling.state}
            audioProcessing={webrtc.audioProcessing}
            onToggleAudioProcessing={webrtc.toggleAudioProcessing}
            aiNsEnabled={noiseSuppression.enabled}
            onToggleAiNs={async () => {
              const track = webrtc.localStreamRef.current?.getAudioTracks()[0];
              if (!track) return;
              const newTrack = await noiseSuppression.toggle(track, webrtc.pcRef, webrtc.localStreamRef);
              if (newTrack) {
                webrtc.setLocalStream((s) =>
                  s ? new MediaStream(s.getTracks()) : s,
                );
              }
            }}
            stats={monitor.stats}
            localSpeaking={vad.localSpeaking}
            audioDevices={audioDevices}
            micLevel={micLevel}
            deafened={app.deafened}
            peersAudioState={chat.peersAudioState}
            peersMutedForMe={chat.peersMutedForMe}
            mutedForPeers={webrtc.mutedForPeers}
            onToggleMuteForPeer={async (peerId: string) => {
              const wasMuted = webrtc.mutedForPeers.has(peerId);
              await webrtc.toggleMuteForPeer(peerId);
              chat.sendSelectiveMute(peerId, !wasMuted);
            }}
            locallyMutedPeers={app.locallyMutedPeers}
            onToggleLocalMutePeer={(peerId: string) => {
              app.setLocallyMutedPeers((prev) => {
                const next = new Set(prev);
                if (next.has(peerId)) next.delete(peerId);
                else next.add(peerId);
                return next;
              });
            }}
            onToggleDeafen={() => {
              const newDeafened = !app.deafened;
              app.setDeafened(newDeafened);
              const track = webrtc.localStreamRef.current?.getAudioTracks()[0];
              const muted = track ? !track.enabled : true;
              chat.sendAudioState(muted, newDeafened);
            }}
            localDisplayName={app.displayName}
            localProfilePic={app.profilePic}
            peerAvatars={chat.peerAvatars}
          />
          </ErrorBoundary>
          </div>
        )}
        {app.activeTab === "files" && (
          <div className="tab-content" key="files">
          <ErrorBoundary fallback="tab">
          <FileShare
            incoming={files.incoming}
            outgoing={files.outgoing}
            sentFiles={files.sentFiles}
            onSendFile={files.sendFile}
            onCancel={files.cancelTransfer}
          />
          </ErrorBoundary>
          </div>
        )}
      </main>
    </div>
  );
}

/** Hidden audio element for a single remote peer — keeps audio playing across tab switches. */
function PeerAudio({ stream, muted }: { stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  // React doesn't reliably update the DOM `muted` property via the JSX attribute
  // (it treats it as an HTML attribute, not a DOM property). Use a ref + effect
  // to ensure muted state is always applied correctly.
  useEffect(() => {
    if (ref.current) ref.current.muted = muted;
  }, [muted]);
  return <audio ref={ref} autoPlay style={{ display: "none" }} />;
}
