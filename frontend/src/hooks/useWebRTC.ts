import { useRef, useState, useCallback, useEffect, type MutableRefObject } from "react";
import { deriveHmacKey } from "../utils/channelAuth";
import { preferVideoCodecs, preferAudioCodecs, optimizeOpusInSDP } from "../utils/codecConfig";
import type { SignalingHook, SignalingMessage, AudioProcessingState } from "../types";

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
};

const MIN_NEGOTIATION_INTERVAL = 2000; // ms — prevent rapid renegotiation

// ---------------------------------------------------------------------------
// Internal per-peer state (not exported — lives in a ref Map)
// ---------------------------------------------------------------------------
interface PeerState {
  remotePeerId: string;
  pc: RTCPeerConnection;
  chatChannel: RTCDataChannel | null;
  fileChannel: RTCDataChannel | null;
  remoteStream: MediaStream;
  remoteScreenStream: MediaStream;
  hmacKey: CryptoKey | null;
  hmacDerived: boolean;
  connectionState: RTCPeerConnectionState;
  makingOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  negotiationQueue: Promise<void>;
  negotiationTimeout: ReturnType<typeof setTimeout> | null;
  lastNegotiatedFingerprint: string;
  lastNegotiationTime: number;
  pendingScreenTrack: boolean;
  screenVideoSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
  cameraVideoSender: RTCRtpSender | null;
  micAudioSender: RTCRtpSender | null;
}

// ---------------------------------------------------------------------------
// Public per-peer info (subset exposed to consumers)
// ---------------------------------------------------------------------------
export interface PeerInfo {
  peerId: string;
  pc: RTCPeerConnection;
  connectionState: RTCPeerConnectionState;
  chatChannel: RTCDataChannel | null;
  fileChannel: RTCDataChannel | null;
  remoteStream: MediaStream;
  remoteScreenStream: MediaStream;
  hmacKey: CryptoKey | null;
}

// ---------------------------------------------------------------------------
// Hook interface
// ---------------------------------------------------------------------------
export interface WebRTCHook {
  init: (iceConfig: RTCConfiguration | null) => void;
  cleanup: () => void;

  // Shared media state
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  localStreamRef: MutableRefObject<MediaStream | null>;
  callError: string | null;
  audioProcessing: AudioProcessingState;
  streamRevision: number;

  // Media operations (apply to all peers)
  startCall: (withVideo?: boolean) => Promise<void>;
  endCall: () => void;
  shareScreen: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  toggleAudio: () => void;
  toggleVideo: () => Promise<void>;
  toggleAudioProcessing: (key: keyof AudioProcessingState) => Promise<void>;
  setLocalStream: (fn: (s: MediaStream | null) => MediaStream | null) => void;
  toggleMuteForPeer: (peerId: string) => Promise<void>;
  mutedForPeers: Set<string>;

  // Multi-peer API
  peers: Map<string, PeerInfo>;
  peerCount: number;
  localPeerId: string | null;

  // Scalar shims — backward compat for Phase 2 (first/primary peer)
  connectionState: string;
  chatChannel: RTCDataChannel | null;
  fileChannel: RTCDataChannel | null;
  remoteStream: MediaStream;
  remoteScreenStream: MediaStream;
  hmacKey: CryptoKey | null;
  pcRef: MutableRefObject<RTCPeerConnection | null>;
  getFingerprint: () => string | null;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------
export default function useWebRTC(signaling: SignalingHook): WebRTCHook {
  // === Refs that mirror props / cross-render state ===
  const signalingRef = useRef(signaling);
  signalingRef.current = signaling;

  // === Per-peer state ===
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const iceConfigRef = useRef<RTCConfiguration>(DEFAULT_ICE_CONFIG);
  const initCalledRef = useRef(false);

  // Revision counter — bumped when any peer state changes to trigger re-render
  const [peerRevision, setPeerRevision] = useState(0);
  const bumpPeers = useCallback(() => setPeerRevision((r) => r + 1), []);

  // === Shared media state ===
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cleaningUpRef = useRef(false);
  const sharingInProgressRef = useRef(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [streamRevision, setStreamRevision] = useState(0);
  const bumpRevision = useCallback(() => setStreamRevision((r) => r + 1), []);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingState>({
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  });

  // Scalar shim ref — points to the "primary" peer's PC for useConnectionMonitor
  const primaryPcRef = useRef<RTCPeerConnection | null>(null);

  const log = useCallback((msg: string) => signalingRef.current.addLog(msg), []);

  // ---------------------------------------------------------------------------
  // Helper: get first connected peer, or first peer, or null
  // ---------------------------------------------------------------------------
  const getPrimaryPeer = useCallback((): PeerState | null => {
    const peers = peersRef.current;
    if (peers.size === 0) return null;
    // Prefer a connected peer
    for (const ps of peers.values()) {
      if (ps.connectionState === "connected") return ps;
    }
    // Fall back to first entry
    return peers.values().next().value ?? null;
  }, []);

  // ---------------------------------------------------------------------------
  // Data channel setup (shared logic)
  // ---------------------------------------------------------------------------
  const setupDataChannel = useCallback((
    channel: RTCDataChannel,
    type: "chat" | "file",
    ps: PeerState,
  ) => {
    channel.onopen = () => {
      if (type === "chat") ps.chatChannel = channel;
      else ps.fileChannel = channel;
      bumpPeers();
    };
    channel.onclose = () => {
      if (type === "chat") ps.chatChannel = null;
      else ps.fileChannel = null;
      bumpPeers();
    };
    // Set immediately for host-created channels (readyState may already be open)
    if (type === "chat") ps.chatChannel = channel;
    else ps.fileChannel = channel;
  }, [bumpPeers]);

  // ---------------------------------------------------------------------------
  // Destroy a single peer connection
  // ---------------------------------------------------------------------------
  const destroyPeerConnection = useCallback((remotePeerId: string) => {
    const ps = peersRef.current.get(remotePeerId);
    if (!ps) return;

    log(`RTC destroying PC for ${remotePeerId.slice(0, 8)}`);
    const { pc } = ps;

    // Clear negotiation timeout
    if (ps.negotiationTimeout !== null) {
      clearTimeout(ps.negotiationTimeout);
      ps.negotiationTimeout = null;
    }

    // Clean up senders
    pc.getSenders().forEach((s) => {
      if (s.track) {
        s.track.onended = null;
        s.track.onmute = null;
        s.track.onunmute = null;
      }
    });
    pc.getReceivers().forEach((r) => {
      if (r.track) {
        r.track.onended = null;
        r.track.onmute = null;
        r.track.onunmute = null;
      }
    });

    // Null out handlers
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.onnegotiationneeded = null;
    pc.ondatachannel = null;
    pc.close();

    peersRef.current.delete(remotePeerId);

    // Update primary PC ref
    const primary = getPrimaryPeer();
    primaryPcRef.current = primary?.pc ?? null;

    bumpPeers();
    bumpRevision();
  }, [log, getPrimaryPeer, bumpPeers, bumpRevision]);

  // ---------------------------------------------------------------------------
  // Create a peer connection for a remote peer
  // ---------------------------------------------------------------------------
  const createPeerConnectionRef = useRef<((remotePeerId: string) => void) | null>(null);
  createPeerConnectionRef.current = (remotePeerId: string) => {
    if (peersRef.current.has(remotePeerId)) return; // already exists
    if (cleaningUpRef.current) return;

    const myId = signalingRef.current.peerId;
    if (!myId) { log("RTC cannot create PC — no local peerId yet"); return; }

    if (typeof RTCPeerConnection === "undefined") {
      log("ERROR: RTCPeerConnection not available");
      setCallError(
        "WebRTC is not supported in this webview. On Linux, install gstreamer WebRTC plugins: sudo apt install gstreamer1.0-nice gstreamer1.0-plugins-bad libgstwebrtc-full-1.0-0"
      );
      return;
    }

    // Negotiation role: lexicographically lower peerId = impolite (creates offer)
    const impolite = myId < remotePeerId;
    log(`RTC creating PC for ${remotePeerId.slice(0, 8)} impolite=${impolite} iceServers=${iceConfigRef.current.iceServers?.length ?? 0}`);

    const pc = new RTCPeerConnection(iceConfigRef.current);

    const ps: PeerState = {
      remotePeerId,
      pc,
      chatChannel: null,
      fileChannel: null,
      remoteStream: new MediaStream(),
      remoteScreenStream: new MediaStream(),
      hmacKey: null,
      hmacDerived: false,
      connectionState: "new",
      makingOffer: false,
      pendingCandidates: [],
      negotiationQueue: Promise.resolve(),
      negotiationTimeout: null,
      lastNegotiatedFingerprint: "",
      lastNegotiationTime: 0,
      pendingScreenTrack: false,
      screenVideoSender: null,
      screenAudioSender: null,
      cameraVideoSender: null,
      micAudioSender: null,
    };

    peersRef.current.set(remotePeerId, ps);

    // --- ICE candidates ---
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signalingRef.current.send({
          type: "ice-candidate",
          candidate: e.candidate.toJSON(),
          to: remotePeerId,
        });
      }
    };

    // --- Connection state changes ---
    pc.onconnectionstatechange = () => {
      log(`RTC [${remotePeerId.slice(0, 8)}] connectionState: ${pc.connectionState}`);
      ps.connectionState = pc.connectionState;

      // Update primary PC ref
      const primary = getPrimaryPeer();
      primaryPcRef.current = primary?.pc ?? null;

      bumpPeers();

      // HMAC key derivation on connect
      if (pc.connectionState === "connected" && !ps.hmacDerived
          && pc.localDescription && pc.remoteDescription) {
        ps.hmacDerived = true;
        let retries = 0;
        const maxRetries = 2;
        const attemptDerive = () => {
          if (!pc.localDescription?.sdp || !pc.remoteDescription?.sdp) return;
          deriveHmacKey(pc.localDescription.sdp, pc.remoteDescription.sdp)
            .then((key) => {
              if (key) {
                ps.hmacKey = key;
                bumpPeers();
              } else if (retries < maxRetries) {
                retries++;
                setTimeout(attemptDerive, 1000 * retries);
              } else {
                log(`HMAC key derivation failed for ${remotePeerId.slice(0, 8)}`);
                ps.hmacDerived = false;
              }
            })
            .catch(() => {
              if (retries < maxRetries) {
                retries++;
                setTimeout(attemptDerive, 1000 * retries);
              } else {
                log(`HMAC key derivation failed for ${remotePeerId.slice(0, 8)}`);
                ps.hmacDerived = false;
              }
            });
        };
        attemptDerive();
      }
    };

    // --- Remote tracks ---
    pc.ontrack = (e) => {
      const isScreen = e.track.kind === "video" && ps.pendingScreenTrack;
      if (isScreen) ps.pendingScreenTrack = false;
      const target = isScreen ? ps.remoteScreenStream : ps.remoteStream;

      if (!target.getTracks().includes(e.track)) {
        target.addTrack(e.track);
        bumpRevision();
      }

      e.track.onmute = bumpRevision;
      e.track.onunmute = bumpRevision;

      e.track.onended = () => {
        for (const stream of [ps.remoteStream, ps.remoteScreenStream]) {
          if (stream.getTracks().includes(e.track)) {
            stream.removeTrack(e.track);
          }
        }
        bumpRevision();
      };
    };

    // --- Data channels ---
    if (impolite) {
      // Impolite peer creates data channels (it will send the offer)
      setupDataChannel(pc.createDataChannel("chat", { ordered: true }), "chat", ps);
      setupDataChannel(pc.createDataChannel("file", { ordered: true }), "file", ps);
    } else {
      // Polite peer receives data channels from remote
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        setupDataChannel(ch, ch.label === "chat" ? "chat" : "file", ps);
      };
    }

    // --- Negotiation ---
    const flushPendingCandidates = async () => {
      while (ps.pendingCandidates.length > 0) {
        const c = ps.pendingCandidates.shift()!;
        try { await pc.addIceCandidate(c); } catch { /* stale candidate */ }
      }
    };

    const getNegotiationFingerprint = (): string => {
      const ids = pc.getSenders().filter((s) => s.track).map((s) => s.track!.id).sort().join(",");
      return `s${ids}`;
    };

    const enqueueNegotiation = () => {
      ps.negotiationQueue = ps.negotiationQueue.then(async () => {
        if (pc.signalingState !== "stable" || ps.makingOffer) {
          log(`RTC [${remotePeerId.slice(0, 8)}] negotiate SKIP state=${pc.signalingState} making=${ps.makingOffer}`);
          return;
        }
        try {
          ps.makingOffer = true;
          log(`RTC [${remotePeerId.slice(0, 8)}] creating offer...`);
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") { log(`RTC [${remotePeerId.slice(0, 8)}] offer aborted`); return; }
          if (offer.sdp) offer.sdp = optimizeOpusInSDP(offer.sdp, !!ps.screenAudioSender);
          await pc.setLocalDescription(offer);
          log(`RTC [${remotePeerId.slice(0, 8)}] offer sent`);
          signalingRef.current.send({
            type: "offer",
            sdp: pc.localDescription!.sdp,
            to: remotePeerId,
          });
        } catch (err) {
          log(`RTC [${remotePeerId.slice(0, 8)}] negotiate ERROR: ${err}`);
          console.error("negotiation error:", err);
        } finally {
          ps.makingOffer = false;
        }
      });
    };

    pc.onnegotiationneeded = () => {
      const fp = getNegotiationFingerprint();
      const now = Date.now();
      const elapsed = now - ps.lastNegotiationTime;
      log(`RTC [${remotePeerId.slice(0, 8)}] onnegotiationneeded fp=${fp} last=${ps.lastNegotiatedFingerprint} elapsed=${elapsed}ms`);
      if (fp !== ps.lastNegotiatedFingerprint) {
        ps.lastNegotiatedFingerprint = fp;
        if (elapsed < MIN_NEGOTIATION_INTERVAL) {
          const delay = MIN_NEGOTIATION_INTERVAL - elapsed;
          log(`RTC [${remotePeerId.slice(0, 8)}] negotiate delayed ${delay}ms`);
          ps.negotiationTimeout = setTimeout(() => {
            ps.negotiationTimeout = null;
            enqueueNegotiation();
          }, delay);
        } else {
          enqueueNegotiation();
        }
        ps.lastNegotiationTime = now;
      }
    };

    // --- Add existing local tracks to new PC ---
    const lStream = localStreamRef.current;
    if (lStream) {
      lStream.getTracks().forEach((t) => {
        const sender = pc.addTrack(t, lStream);
        if (t.kind === "audio") {
          ps.micAudioSender = sender;
          preferAudioCodecs(pc);
        }
        if (t.kind === "video") {
          ps.cameraVideoSender = sender;
          preferVideoCodecs(pc, "camera");
        }
      });
    }

    // Add existing screen share tracks
    const sStream = screenStreamRef.current;
    if (sStream) {
      const screenTrack = sStream.getVideoTracks()[0];
      if (screenTrack) {
        ps.screenVideoSender = pc.addTrack(screenTrack, sStream);
        preferVideoCodecs(pc, "screen");
        signalingRef.current.send({ type: "screen-sharing", active: true, trackId: screenTrack.id, to: remotePeerId });
      }
      const audioTrack = sStream.getAudioTracks()[0];
      if (audioTrack) {
        ps.screenAudioSender = pc.addTrack(audioTrack, sStream);
      }
    }

    // Update primary PC ref
    primaryPcRef.current = (getPrimaryPeer() ?? ps).pc;
    bumpPeers();

    // --- If impolite, initiate negotiation ---
    if (impolite) {
      ps.lastNegotiatedFingerprint = getNegotiationFingerprint();
      ps.lastNegotiationTime = Date.now();
      enqueueNegotiation();
    }

    // Store the handler functions on PeerState for signaling dispatch
    (ps as any)._flushPendingCandidates = flushPendingCandidates;
    (ps as any)._enqueueNegotiation = enqueueNegotiation;
  };

  // ---------------------------------------------------------------------------
  // Signaling message handler — dispatches to per-peer PCs
  // ---------------------------------------------------------------------------
  const handleSignalingMessage = useCallback(async (msg: SignalingMessage) => {
    if (cleaningUpRef.current) return;

    try {
      if (msg.type === "room-state" && "peers" in msg) {
        // Create PCs for all existing peers in the room
        for (const peerId of msg.peers) {
          createPeerConnectionRef.current?.(peerId);
        }
        return;
      }

      if (msg.type === "peer-joined" && "peerId" in msg) {
        createPeerConnectionRef.current?.(msg.peerId);
        return;
      }

      if (msg.type === "peer-disconnected" && "peerId" in msg) {
        destroyPeerConnection(msg.peerId);
        return;
      }

      // All other messages need a `from` field to dispatch to the right PC
      const from = (msg as any).from as string | undefined;
      if (!from) { log(`RTC ignoring ${msg.type} — no from field`); return; }

      const ps = peersRef.current.get(from);
      if (!ps) { log(`RTC ignoring ${msg.type} from ${from.slice(0, 8)} — no PC`); return; }

      const { pc } = ps;
      const myId = signalingRef.current.peerId;
      const impolite = myId ? myId < from : false;

      log(`RTC [${from.slice(0, 8)}] handle ${msg.type} pcState=${pc.signalingState}`);

      if (msg.type === "offer") {
        const collision = ps.makingOffer || pc.signalingState !== "stable";
        if (collision && impolite) {
          log(`RTC [${from.slice(0, 8)}] offer ignored (impolite collision)`);
          return;
        }
        if (collision) {
          await pc.setLocalDescription({ type: "rollback" });
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        } else {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        }
        await (ps as any)._flushPendingCandidates();
        const answer = await pc.createAnswer();
        if (answer.sdp) answer.sdp = optimizeOpusInSDP(answer.sdp, !!ps.screenAudioSender);
        await pc.setLocalDescription(answer);
        log(`RTC [${from.slice(0, 8)}] answer sent`);
        signalingRef.current.send({
          type: "answer",
          sdp: pc.localDescription!.sdp,
          to: from,
        });
      } else if (msg.type === "answer") {
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          await (ps as any)._flushPendingCandidates();
        }
      } else if (msg.type === "ice-candidate" && msg.candidate) {
        if (!pc.remoteDescription) {
          ps.pendingCandidates.push(msg.candidate);
        } else {
          try { await pc.addIceCandidate(msg.candidate); } catch { /* stale */ }
        }
      } else if (msg.type === "screen-sharing") {
        if (msg.active) {
          ps.pendingScreenTrack = true;
        } else {
          ps.pendingScreenTrack = false;
          const sStream = ps.remoteScreenStream;
          sStream.getTracks().forEach((t) => sStream.removeTrack(t));
          bumpRevision();
        }
      }
    } catch (err) {
      console.error("signaling handler error:", err);
    }
  }, [destroyPeerConnection, log, bumpRevision]);

  // ---------------------------------------------------------------------------
  // init() — stores ICE config, registers signaling handler
  // ---------------------------------------------------------------------------
  const init = useCallback((iceConfig: RTCConfiguration | null) => {
    if (initCalledRef.current) return;
    initCalledRef.current = true;
    iceConfigRef.current = iceConfig || DEFAULT_ICE_CONFIG;
    log(`RTC init iceServers=${iceConfigRef.current.iceServers?.length ?? 0}`);
    signalingRef.current.onMessage(handleSignalingMessage);
  }, [handleSignalingMessage, log]);

  // ---------------------------------------------------------------------------
  // cleanup() — destroy all PCs, reset shared state
  // ---------------------------------------------------------------------------
  const cleanup = useCallback(() => {
    cleaningUpRef.current = true;

    // Stop local media
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    screenStreamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    screenStreamRef.current = null;
    sharingInProgressRef.current = false;

    // Destroy all peer connections
    for (const remotePeerId of [...peersRef.current.keys()]) {
      destroyPeerConnection(remotePeerId);
    }
    peersRef.current.clear();
    primaryPcRef.current = null;
    initCalledRef.current = false;

    // Reset React state
    setLocalStream(null);
    setScreenStream(null);
    setCallError(null);
    setAudioProcessing({ noiseSuppression: true, echoCancellation: true, autoGainControl: true });
    bumpPeers();
    bumpRevision();

    cleaningUpRef.current = false;
  }, [destroyPeerConnection, bumpPeers, bumpRevision]);

  // ---------------------------------------------------------------------------
  // startCall — get user media, add tracks to all existing PCs
  // ---------------------------------------------------------------------------
  const startCall = useCallback(async (_withVideo = false) => {
    if (peersRef.current.size === 0 && !initCalledRef.current) return;
    setCallError(null);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCallError(
        "Camera/microphone not available. This requires a browser like Chrome — pywebview's embedded browser does not support WebRTC media."
      );
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasAudio = devices.some((d) => d.kind === "audioinput");
      if (!hasAudio) { setCallError("No microphone found on this device."); return; }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
        video: false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Add tracks to all existing PCs
      for (const ps of peersRef.current.values()) {
        stream.getTracks().forEach((t) => {
          const sender = ps.pc.addTrack(t, stream);
          if (t.kind === "audio") ps.micAudioSender = sender;
        });
        preferAudioCodecs(ps.pc);
      }
    } catch (err) {
      console.error("startCall failed:", err);
      setCallError((err as Error).message || "Failed to access camera/microphone");
    }
  }, []);

  // ---------------------------------------------------------------------------
  // endCall — stop senders on all PCs
  // ---------------------------------------------------------------------------
  const endCall = useCallback(() => {
    // Stop screen share first
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      screenStreamRef.current = null;
    }

    for (const ps of peersRef.current.values()) {
      const { pc } = ps;
      // Remove screen senders
      if (ps.screenVideoSender) {
        try { pc.removeTrack(ps.screenVideoSender); } catch { /* already removed */ }
        ps.screenVideoSender = null;
      }
      if (ps.screenAudioSender) {
        try { pc.removeTrack(ps.screenAudioSender); } catch { /* already removed */ }
        ps.screenAudioSender = null;
      }
      if (ps.cameraVideoSender) {
        try { pc.removeTrack(ps.cameraVideoSender); } catch { /* already removed */ }
        ps.cameraVideoSender = null;
      }
      // Stop remaining senders (mic, camera)
      pc.getSenders().forEach((s) => {
        if (s.track) {
          s.track.stop();
          pc.removeTrack(s);
        }
      });
    }
    sharingInProgressRef.current = false;
    localStreamRef.current = null;
    setLocalStream(null);
    setScreenStream(null);
  }, []);

  // ---------------------------------------------------------------------------
  // stopScreenShare — remove screen senders from all PCs
  // ---------------------------------------------------------------------------
  const stopScreenShare = useCallback(async () => {
    if (!screenStreamRef.current) return;

    sharingInProgressRef.current = false;
    screenStreamRef.current.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    screenStreamRef.current = null;
    setScreenStream(null);

    for (const ps of peersRef.current.values()) {
      const { pc } = ps;
      if (ps.screenAudioSender) {
        try { pc.removeTrack(ps.screenAudioSender); } catch { /* already removed */ }
        ps.screenAudioSender = null;
      }
      if (ps.screenVideoSender) {
        try { pc.removeTrack(ps.screenVideoSender); } catch { /* already removed */ }
        ps.screenVideoSender = null;
      }
    }

    // Broadcast stop to all peers
    signalingRef.current.send({ type: "screen-sharing", active: false });
  }, []);

  // ---------------------------------------------------------------------------
  // shareScreen — get display media, add to all PCs
  // ---------------------------------------------------------------------------
  const shareScreen = useCallback(async () => {
    if (peersRef.current.size === 0 || sharingInProgressRef.current) return;

    if (!navigator.mediaDevices?.getDisplayMedia) {
      setCallError("Screen sharing is not supported in this browser.");
      return;
    }

    setCallError(null);
    sharingInProgressRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, cursor: "always" } as MediaTrackConstraints,
        audio: {
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false,
        },
        systemAudio: "include",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      } as any);

      if (!sharingInProgressRef.current || cleaningUpRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      screenStreamRef.current = stream;
      const screenTrack = stream.getVideoTracks()[0];

      // Add screen track to all PCs
      for (const ps of peersRef.current.values()) {
        const { pc } = ps;
        if (ps.screenVideoSender) {
          try { pc.removeTrack(ps.screenVideoSender); } catch { /* already removed */ }
        }
        ps.screenVideoSender = pc.addTrack(screenTrack, stream);
        preferVideoCodecs(pc, "screen");

        // Set initial bitrate
        if (ps.screenVideoSender) {
          try {
            const params = ps.screenVideoSender.getParameters();
            if (params.encodings?.length > 0) {
              params.encodings[0].maxBitrate = 1_500_000;
              params.encodings[0].maxFramerate = 30;
              (params.encodings[0] as any).degradationPreference = "maintain-framerate";
              await ps.screenVideoSender.setParameters(params);
            }
          } catch { /* encoding params not supported */ }
        }

        // Add system audio if present
        if (ps.screenAudioSender) {
          try { pc.removeTrack(ps.screenAudioSender); } catch { /* already removed */ }
          ps.screenAudioSender = null;
        }
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          if ("contentHint" in audioTrack) audioTrack.contentHint = "music";
          try {
            ps.screenAudioSender = pc.addTrack(audioTrack, stream);
            const params = ps.screenAudioSender.getParameters();
            if (params.encodings?.length > 0) {
              params.encodings[0].maxBitrate = 128_000;
              await ps.screenAudioSender.setParameters(params);
            }
          } catch (err) {
            console.error("failed to add screen audio:", err);
          }
        }
      }

      // Notify all peers
      if ("contentHint" in screenTrack) screenTrack.contentHint = "detail";
      signalingRef.current.send({ type: "screen-sharing", active: true, trackId: screenTrack.id });

      screenTrack.onended = () => {
        if (sharingInProgressRef.current) return;
        stopScreenShare().catch((err: unknown) =>
          console.error("stopScreenShare from onended failed:", err)
        );
      };

      setScreenStream(stream);
    } catch (err) {
      const e = err as DOMException;
      if (e.name !== "AbortError" && e.name !== "NotAllowedError") {
        setCallError(e.message || "Failed to share screen");
      }
    } finally {
      sharingInProgressRef.current = false;
    }
  }, [stopScreenShare]);

  // ---------------------------------------------------------------------------
  // Per-peer selective mute — stop sending audio to a specific peer
  // ---------------------------------------------------------------------------
  const mutedForPeersRef = useRef<Set<string>>(new Set());
  const [mutedForPeers, setMutedForPeers] = useState<Set<string>>(new Set());

  const muteForPeer = useCallback(async (peerId: string) => {
    const ps = peersRef.current.get(peerId);
    if (!ps?.micAudioSender) return;
    try { await ps.micAudioSender.replaceTrack(null); } catch { /* sender gone */ }
    mutedForPeersRef.current.add(peerId);
    setMutedForPeers(new Set(mutedForPeersRef.current));
  }, []);

  const unmuteForPeer = useCallback(async (peerId: string) => {
    const ps = peersRef.current.get(peerId);
    if (!ps?.micAudioSender) return;
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    if (!audioTrack) return;
    try { await ps.micAudioSender.replaceTrack(audioTrack); } catch { /* sender gone */ }
    mutedForPeersRef.current.delete(peerId);
    setMutedForPeers(new Set(mutedForPeersRef.current));
  }, []);

  const toggleMuteForPeer = useCallback(async (peerId: string) => {
    if (mutedForPeersRef.current.has(peerId)) {
      await unmuteForPeer(peerId);
    } else {
      await muteForPeer(peerId);
    }
  }, [muteForPeer, unmuteForPeer]);

  // ---------------------------------------------------------------------------
  // toggleAudio
  // ---------------------------------------------------------------------------
  const toggleAudio = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = !track.enabled;
    setLocalStream((s) => (s ? new MediaStream(s.getTracks()) : s));
  }, []);

  // ---------------------------------------------------------------------------
  // toggleVideo — add/remove camera track on all PCs
  // ---------------------------------------------------------------------------
  const toggleVideo = useCallback(async () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const existingTrack = stream.getVideoTracks()[0];
    if (existingTrack) {
      // Turn camera off
      existingTrack.stop();
      stream.removeTrack(existingTrack);
      for (const ps of peersRef.current.values()) {
        const sender = ps.cameraVideoSender
          && ps.pc.getSenders().includes(ps.cameraVideoSender)
          ? ps.cameraVideoSender
          : ps.pc.getSenders().find((s) => s.track === existingTrack);
        if (sender) {
          try { await sender.replaceTrack(null); } catch { /* sender gone */ }
        }
      }
    } else {
      // Turn camera on
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        });
        if (cleaningUpRef.current) { videoStream.getTracks().forEach((t) => t.stop()); return; }
        const newTrack = videoStream.getVideoTracks()[0];
        stream.addTrack(newTrack);

        for (const ps of peersRef.current.values()) {
          const { pc } = ps;
          const existingSender = ps.cameraVideoSender
            && pc.getSenders().includes(ps.cameraVideoSender)
            ? ps.cameraVideoSender
            : null;
          if (existingSender) {
            await existingSender.replaceTrack(newTrack);
          } else {
            ps.cameraVideoSender = pc.addTrack(newTrack, stream);
          }
          preferVideoCodecs(pc, "camera");

          // Set initial camera bitrate
          const camSender = ps.cameraVideoSender;
          if (camSender) {
            try {
              const params = camSender.getParameters();
              if (params.encodings?.length > 0) {
                params.encodings[0].maxBitrate = 1_500_000;
                params.encodings[0].maxFramerate = 24;
                (params.encodings[0] as any).degradationPreference = "maintain-framerate";
                await camSender.setParameters(params);
              }
            } catch { /* encoding params not supported */ }
          }
        }
      } catch (err) {
        const msg = (err as DOMException)?.name === "NotAllowedError"
          ? "Camera permission denied."
          : "Failed to access camera.";
        setCallError(msg);
        return;
      }
    }
    setLocalStream(new MediaStream(stream.getTracks()));
  }, []);

  // ---------------------------------------------------------------------------
  // toggleAudioProcessing — replace audio track on all PCs
  // ---------------------------------------------------------------------------
  const toggleAudioProcessing = useCallback(async (key: keyof AudioProcessingState) => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;

    const currentSettings = track.getSettings();
    const nextVal = !(currentSettings[key] ?? true);

    // Fast path: applyConstraints
    try {
      await track.applyConstraints({ [key]: nextVal });
      const actualVal = track.getSettings()[key];
      if (actualVal === nextVal) {
        setAudioProcessing((prev) => ({ ...prev, [key]: nextVal }));
        return;
      }
    } catch { /* fall through */ }

    // Slow path: full track replacement
    const senders: { ps: PeerState; sender: RTCRtpSender }[] = [];
    for (const ps of peersRef.current.values()) {
      const sender = ps.pc.getSenders().find(
        (s) => s.track === track || s.track?.kind === "audio",
      );
      if (sender) senders.push({ ps, sender });
    }

    const deviceId = currentSettings.deviceId;
    const constraints: MediaTrackConstraints = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      noiseSuppression: key === "noiseSuppression" ? nextVal : (currentSettings.noiseSuppression ?? true),
      echoCancellation: key === "echoCancellation" ? nextVal : (currentSettings.echoCancellation ?? true),
      autoGainControl: key === "autoGainControl" ? nextVal : (currentSettings.autoGainControl ?? true),
    };

    track.stop();

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      if (cleaningUpRef.current || !localStreamRef.current) {
        newStream.getTracks().forEach((t) => t.stop());
        return;
      }

      const newTrack = newStream.getAudioTracks()[0];
      for (const { ps, sender } of senders) {
        // Don't restore audio for selectively-muted peers
        if (mutedForPeersRef.current.has(ps.remotePeerId)) continue;
        await sender.replaceTrack(newTrack);
      }

      localStreamRef.current.removeTrack(track);
      localStreamRef.current.addTrack(newTrack);
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()));

      const newSettings = newTrack.getSettings();
      setAudioProcessing({
        noiseSuppression: newSettings.noiseSuppression ?? true,
        echoCancellation: newSettings.echoCancellation ?? true,
        autoGainControl: newSettings.autoGainControl ?? true,
      });
    } catch (err) {
      console.warn("toggleAudioProcessing: track replacement failed:", err);
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cleaningUpRef.current || !localStreamRef.current) {
          fallbackStream.getTracks().forEach((t) => t.stop());
          return;
        }
        const fallbackTrack = fallbackStream.getAudioTracks()[0];
        for (const { ps, sender } of senders) {
          // Don't restore audio for selectively-muted peers
          if (mutedForPeersRef.current.has(ps.remotePeerId)) continue;
          await sender.replaceTrack(fallbackTrack);
        }
        localStreamRef.current.removeTrack(track);
        localStreamRef.current.addTrack(fallbackTrack);
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));

        const fbSettings = fallbackTrack.getSettings();
        setAudioProcessing({
          noiseSuppression: fbSettings.noiseSuppression ?? true,
          echoCancellation: fbSettings.echoCancellation ?? true,
          autoGainControl: fbSettings.autoGainControl ?? true,
        });
      } catch {
        console.error("toggleAudioProcessing: emergency fallback also failed — no audio");
      }
    }
  }, []);

  // ---------------------------------------------------------------------------
  // getFingerprint — from primary peer's PC
  // ---------------------------------------------------------------------------
  const getFingerprint = useCallback((): string | null => {
    const primary = getPrimaryPeer();
    const sdp = primary?.pc.localDescription?.sdp;
    if (!sdp) return null;
    const match = sdp.match(/a=fingerprint:\S+ (\S+)/);
    return match ? match[1] : null;
  }, [getPrimaryPeer]);

  // ---------------------------------------------------------------------------
  // Auto-switch audio device (iterate all PCs)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!localStream) return;
    const handleDeviceChange = async () => {
      if (cleaningUpRef.current) return;
      const currentTrack = localStreamRef.current?.getAudioTracks()[0];
      if (!currentTrack) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (cleaningUpRef.current || !localStreamRef.current) return;
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      const currentId = currentTrack.getSettings().deviceId;
      const stillExists = audioDevices.some((d) => d.deviceId === currentId);
      if (!stillExists && audioDevices.length > 0) {
        try {
          const settings = currentTrack.getSettings();
          const newStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: settings.noiseSuppression ?? true,
              echoCancellation: settings.echoCancellation ?? true,
              autoGainControl: settings.autoGainControl ?? true,
            },
          });
          if (cleaningUpRef.current || !localStreamRef.current) {
            newStream.getTracks().forEach((t) => t.stop());
            return;
          }
          const newTrack = newStream.getAudioTracks()[0];
          // Replace on all PCs
          for (const ps of peersRef.current.values()) {
            const sender = ps.pc.getSenders().find((s) => s.track?.kind === "audio");
            if (sender) await sender.replaceTrack(newTrack);
          }
          currentTrack.stop();
          localStreamRef.current.removeTrack(currentTrack);
          localStreamRef.current.addTrack(newTrack);
          setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        } catch (err) {
          console.error("device switch failed:", err);
        }
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [localStream]);

  // ---------------------------------------------------------------------------
  // Adaptive quality — cap resolution/fps based on peer count
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const count = peersRef.current.size;
    if (count < 5) return; // no cap for 1-4 peers

    const applyAdaptiveQuality = async () => {
      let maxBitrate: number;
      let maxFramerate: number;
      let scaleDown: number;
      if (count >= 7) {
        // 7-8 peers: 360p/12fps
        maxBitrate = 350_000;
        maxFramerate = 12;
        scaleDown = 2;
      } else {
        // 5-6 peers: 480p/15fps
        maxBitrate = 600_000;
        maxFramerate = 15;
        scaleDown = 1.5;
      }

      for (const ps of peersRef.current.values()) {
        for (const sender of ps.pc.getSenders()) {
          if (sender.track?.kind !== "video") continue;
          try {
            const params = sender.getParameters();
            if (!params.encodings?.length) continue;
            params.encodings[0].maxBitrate = maxBitrate;
            params.encodings[0].maxFramerate = maxFramerate;
            params.encodings[0].scaleResolutionDownBy = scaleDown;
            await sender.setParameters(params);
          } catch { /* encoding params not supported */ }
        }
      }
    };

    applyAdaptiveQuality();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerRevision]);

  // Cleanup on unmount
  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  // ---------------------------------------------------------------------------
  // Build return value — compute maps and scalar shims
  // ---------------------------------------------------------------------------
  // Build peers map (read peerRevision to ensure re-computation)
  void peerRevision;
  const peersMap = new Map<string, PeerInfo>();
  for (const [id, ps] of peersRef.current) {
    peersMap.set(id, {
      peerId: ps.remotePeerId,
      pc: ps.pc,
      connectionState: ps.connectionState,
      chatChannel: ps.chatChannel,
      fileChannel: ps.fileChannel,
      remoteStream: ps.remoteStream,
      remoteScreenStream: ps.remoteScreenStream,
      hmacKey: ps.hmacKey,
    });
  }

  // Scalar shims from primary peer
  const primary = getPrimaryPeer();
  const overallState = (() => {
    if (peersRef.current.size === 0) return "new";
    for (const ps of peersRef.current.values()) {
      if (ps.connectionState === "connected") return "connected";
    }
    for (const ps of peersRef.current.values()) {
      if (ps.connectionState === "connecting") return "connecting";
    }
    return primary?.connectionState ?? "new";
  })();

  return {
    init,
    cleanup,

    // Shared media
    localStream,
    screenStream,
    localStreamRef,
    callError,
    audioProcessing,
    streamRevision,

    // Media operations
    startCall,
    endCall,
    shareScreen,
    stopScreenShare,
    toggleAudio,
    toggleVideo,
    toggleAudioProcessing,
    setLocalStream,
    toggleMuteForPeer,
    mutedForPeers,

    // Multi-peer API
    peers: peersMap,
    peerCount: peersRef.current.size,
    localPeerId: signaling.peerId,

    // Scalar shims
    connectionState: overallState,
    chatChannel: primary?.chatChannel ?? null,
    fileChannel: primary?.fileChannel ?? null,
    remoteStream: primary?.remoteStream ?? new MediaStream(),
    remoteScreenStream: primary?.remoteScreenStream ?? new MediaStream(),
    hmacKey: primary?.hmacKey ?? null,
    pcRef: primaryPcRef,
    getFingerprint,
  };
}
