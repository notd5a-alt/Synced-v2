import { useRef, useState, useCallback, useEffect, type MutableRefObject } from "react";
import { deriveHmacKey } from "../utils/channelAuth";
import { preferVideoCodecs, preferAudioCodecs, optimizeOpusInSDP } from "../utils/codecConfig";
import type { SignalingHook, SignalingMessage, AudioProcessingState } from "../types";

const DEFAULT_ICE_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export interface WebRTCHook {
  init: (iceConfig: RTCConfiguration | null) => void;
  connectionState: string;
  chatChannel: RTCDataChannel | null;
  fileChannel: RTCDataChannel | null;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
  startCall: (withVideo?: boolean) => Promise<void>;
  endCall: () => void;
  shareScreen: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  screenStream: MediaStream | null;
  toggleAudio: () => void;
  toggleVideo: () => Promise<void>;
  cleanup: () => void;
  getFingerprint: () => string | null;
  callError: string | null;
  pcRef: MutableRefObject<RTCPeerConnection | null>;
  hmacKey: CryptoKey | null;
  audioProcessing: AudioProcessingState;
  toggleAudioProcessing: (key: keyof AudioProcessingState) => Promise<void>;
}

export default function useWebRTC(signaling: SignalingHook, isHost: boolean): WebRTCHook {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const chatChannelRef = useRef<RTCDataChannel | null>(null);
  const fileChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const makingOfferRef = useRef(false);
  const negotiationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const isHostRef = useRef(isHost);
  const signalingRef = useRef(signaling);

  isHostRef.current = isHost;
  signalingRef.current = signaling;

  const screenStreamRef = useRef<MediaStream | null>(null);

  const [connectionState, setConnectionState] = useState("new");
  const [chatChannel, setChatChannel] = useState<RTCDataChannel | null>(null);
  const [fileChannel, setFileChannel] = useState<RTCDataChannel | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [hmacKey, setHmacKey] = useState<CryptoKey | null>(null);
  const [audioProcessing, setAudioProcessing] = useState<AudioProcessingState>({
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  });

  const setupDataChannel = useCallback((channel: RTCDataChannel, type: "chat" | "file") => {
    channel.onopen = () => {
      if (type === "chat") setChatChannel(channel);
      else setFileChannel(channel);
    };
    channel.onclose = () => {
      if (type === "chat") setChatChannel(null);
      else setFileChannel(null);
    };
    if (type === "chat") chatChannelRef.current = channel;
    else fileChannelRef.current = channel;
  }, []);

  const cleanup = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    screenAudioSenderRef.current = null;
    screenVideoSenderRef.current = null;
    sharingInProgressRef.current = false;
    // Clear track event handlers to prevent leaks
    const pc = pcRef.current;
    if (pc) {
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
      pc.close();
    }
    pcRef.current = null;
    // Reset negotiation queue so pending ops don't run on closed PC
    negotiationQueueRef.current = Promise.resolve();
    makingOfferRef.current = false;
    chatChannelRef.current = null;
    fileChannelRef.current = null;
    setChatChannel(null);
    setFileChannel(null);
    setLocalStream(null);
    setScreenStream(null);
    setRemoteStream(null);
    setCallError(null);
    setHmacKey(null);
    setAudioProcessing({ noiseSuppression: true, echoCancellation: true, autoGainControl: true });
    setConnectionState("new");
  }, []);

  const init = useCallback((iceConfig: RTCConfiguration | null) => {
    if (pcRef.current) return;

    const host = isHostRef.current;
    const sig = signalingRef.current;
    const pc = new RTCPeerConnection(iceConfig || DEFAULT_ICE_CONFIG);
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        signalingRef.current.send({
          type: "ice-candidate",
          candidate: e.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState);
      if (pc.connectionState === "connected" && pc.localDescription && pc.remoteDescription) {
        deriveHmacKey(pc.localDescription.sdp, pc.remoteDescription.sdp)
          .then((key) => { if (key) setHmacKey(key); })
          .catch(() => {});
      }
    };

    // Remote media tracks — use e.track directly
    const remote = new MediaStream();
    setRemoteStream(remote);
    pc.ontrack = (e) => {
      // Only add unmuted live tracks; muted tracks arrive after peer ends call
      if (!e.track.muted) {
        remote.addTrack(e.track);
        setRemoteStream(new MediaStream(remote.getTracks()));
      }

      // Remove ended tracks so stale frames don't linger
      e.track.onended = () => {
        if (remote.getTracks().includes(e.track)) {
          remote.removeTrack(e.track);
        }
        setRemoteStream(new MediaStream(remote.getTracks()));
      };
      e.track.onmute = () => {
        if (remote.getTracks().includes(e.track)) {
          remote.removeTrack(e.track);
        }
        setRemoteStream(new MediaStream(remote.getTracks()));
      };
      e.track.onunmute = () => {
        if (!remote.getTracks().includes(e.track)) {
          remote.addTrack(e.track);
        }
        setRemoteStream(new MediaStream(remote.getTracks()));
      };
    };

    if (host) {
      setupDataChannel(pc.createDataChannel("chat", { ordered: true }), "chat");
      setupDataChannel(pc.createDataChannel("file", { ordered: true }), "file");
    } else {
      pc.ondatachannel = (e) => {
        const ch = e.channel;
        setupDataChannel(ch, ch.label === "chat" ? "chat" : "file");
      };
    }

    // Serialized offer creation — prevents duplicate/racing offers
    let peerPresent = false;

    const enqueueNegotiation = () => {
      negotiationQueueRef.current = negotiationQueueRef.current.then(async () => {
        const pc = pcRef.current;
        if (!pc || pc.signalingState !== "stable" || makingOfferRef.current) {
          console.log("[webrtc] negotiation skipped: pc=%s, state=%s, makingOffer=%s",
            !!pc, pc?.signalingState, makingOfferRef.current);
          return;
        }
        try {
          makingOfferRef.current = true;
          const offer = await pc.createOffer();
          if (pc.signalingState !== "stable") return;
          // Optimize Opus params before setting local description
          if (offer.sdp) offer.sdp = optimizeOpusInSDP(offer.sdp);
          await pc.setLocalDescription(offer);
          signalingRef.current.send({
            type: "offer",
            sdp: pc.localDescription!.sdp,
          });
        } catch (err) {
          console.error("negotiation error:", err);
        } finally {
          makingOfferRef.current = false;
        }
      });
    };

    // Suppress negotiation until a peer has joined — prevents sending
    // offers into the void (which leaves the PC stuck in have-local-offer)
    pc.onnegotiationneeded = () => {
      if (peerPresent) enqueueNegotiation();
    };

    sig.onMessage(async (msg: SignalingMessage) => {
      const pc = pcRef.current;
      if (!pc) return;
      const host = isHostRef.current;

      try {
        if (msg.type === "offer" || msg.type === "answer") {
          console.log("[webrtc] received %s, pcState=%s", msg.type, pc.signalingState);
        }
        if (msg.type === "offer") {
          const collision =
            makingOfferRef.current || pc.signalingState !== "stable";
          if (collision && host) return;
          if (collision) {
            await Promise.all([
              pc.setLocalDescription({ type: "rollback" }),
              pc.setRemoteDescription({ type: "offer", sdp: msg.sdp }),
            ]);
          } else {
            await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          }
          const answer = await pc.createAnswer();
          // Optimize Opus params before setting local description
          if (answer.sdp) answer.sdp = optimizeOpusInSDP(answer.sdp);
          await pc.setLocalDescription(answer);
          signalingRef.current.send({
            type: "answer",
            sdp: pc.localDescription!.sdp,
          });
        } else if (msg.type === "answer") {
          if (pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          }
        } else if (msg.type === "ice-candidate" && msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate);
          } catch { /* ICE candidate error */ }
        } else if (msg.type === "peer-joined") {
          console.log("[webrtc] peer-joined, host=%s, pcState=%s", host, pc.signalingState);
          peerPresent = true;
          if (host) {
            // If a previous offer was sent but the answer never arrived
            // (e.g., signaling dropped), the PC is stuck in have-local-offer.
            // Roll back so enqueueNegotiation can create a fresh offer.
            if (pc.signalingState === "have-local-offer") {
              console.log("[webrtc] rolling back stuck have-local-offer");
              await pc.setLocalDescription({ type: "rollback" });
            }
            enqueueNegotiation();
          }
        } else if (msg.type === "peer-disconnected") {
          peerPresent = false;
          cleanup();
        }
      } catch (err) {
        console.error("signaling handler error:", err);
      }
    });
  }, [setupDataChannel, cleanup]);

  const startCall = useCallback(async (_withVideo = false) => {
    const pc = pcRef.current;
    if (!pc) return;
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

      if (!hasAudio) {
        setCallError("No microphone found on this device.");
        return;
      }

      // Always start audio-only; camera stays off until user turns it on
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
        video: false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      // Set codec preferences after transceivers exist
      preferAudioCodecs(pc);
    } catch (err) {
      console.error("startCall failed:", err);
      setCallError((err as Error).message || "Failed to access camera/microphone");
    }
  }, []);

  const endCall = useCallback(() => {
    const pc = pcRef.current;
    if (!pc) return;
    // Stop all media senders
    pc.getSenders().forEach((s) => {
      if (s.track) {
        s.track.stop();
        pc.removeTrack(s);
      }
    });
    localStreamRef.current = null;
    setLocalStream(null);
    screenStreamRef.current = null;
    setScreenStream(null);
    screenAudioSenderRef.current = null;
    screenVideoSenderRef.current = null;
    sharingInProgressRef.current = false;
  }, []);

  const screenAudioSenderRef = useRef<RTCRtpSender | null>(null);
  const sharingInProgressRef = useRef(false);
  const screenVideoSenderRef = useRef<RTCRtpSender | null>(null);

   
  const stopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !screenStreamRef.current) return;

    sharingInProgressRef.current = false;
    screenStreamRef.current.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setScreenStream(null);

    // Remove the system audio sender
    if (screenAudioSenderRef.current) {
      try { pc.removeTrack(screenAudioSenderRef.current); } catch { /* already removed */ }
      screenAudioSenderRef.current = null;
    }

    // Swap back to camera track only if it's still alive
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    const videoSender = pc.getSenders().find((s) => s.track?.kind === "video")
      || screenVideoSenderRef.current;

    if (videoSender && cameraTrack?.readyState === "live") {
      try { await videoSender.replaceTrack(cameraTrack); } catch (err) {
        console.error("stopScreenShare: replaceTrack failed:", err);
      }
      screenVideoSenderRef.current = null;
    } else if (videoSender) {
      try { await videoSender.replaceTrack(null); } catch (err) {
        console.error("stopScreenShare: replaceTrack(null) failed:", err);
      }
      // Keep screenVideoSenderRef — shareScreen will reuse this sender
    }
  }, []);

  const shareScreen = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || sharingInProgressRef.current) return;
    setCallError(null);
    sharingInProgressRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, cursor: "always" } as MediaTrackConstraints,
        audio: true, // request system audio (Chrome shows a checkbox)
      });

      // If stopScreenShare was called while awaiting getDisplayMedia, abort
      if (!sharingInProgressRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      screenStreamRef.current = stream;

      // Replace the camera video track with the screen track (no extra tracks)
      const screenTrack = stream.getVideoTracks()[0];
      // Hint encoder to prioritize smooth motion over pixel-perfect sharpness
      if ("contentHint" in screenTrack) screenTrack.contentHint = "motion";

      // 1. Find sender with active video track (e.g., camera)
      let videoSender = pc.getSenders().find((s) => s.track?.kind === "video");

      // 2. Reuse saved sender from previous screen share (has null track)
      if (!videoSender && screenVideoSenderRef.current) {
        if (pc.getSenders().includes(screenVideoSenderRef.current)) {
          videoSender = screenVideoSenderRef.current;
        } else {
          screenVideoSenderRef.current = null;
        }
      }

      // 3. Replace track or add new sender as last resort
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
        screenVideoSenderRef.current = videoSender;
      } else {
        screenVideoSenderRef.current = pc.addTrack(screenTrack, stream);
      }

      // Boost bitrate for screen content (higher res than camera)
      const screenSender = screenVideoSenderRef.current;
      if (screenSender) {
        try {
          const params = screenSender.getParameters();
          if (params.encodings?.length > 0) {
            params.encodings[0].maxBitrate = 4_000_000; // 4 Mbps for crisp screen
            params.encodings[0].maxFramerate = 30;
            await screenSender.setParameters(params);
          }
        } catch { /* encoding params not supported */ }
      }

      // Add system audio track if the user chose to share it
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        screenAudioSenderRef.current = pc.addTrack(audioTrack, stream);
      }

      // State update after all track operations are complete
      setScreenStream(stream);

      // When user stops sharing via browser's built-in "Stop sharing" button
      screenTrack.onended = () => {
        stopScreenShare().catch((err: unknown) =>
          console.error("stopScreenShare from onended failed:", err)
        );
      };
    } catch (err) {
      const e = err as DOMException;
      if (e.name !== "AbortError" && e.name !== "NotAllowedError") {
        setCallError(e.message || "Failed to share screen");
      }
    } finally {
      sharingInProgressRef.current = false;
    }
  }, [stopScreenShare]);

  const toggleAudio = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = !track.enabled;
    setLocalStream((s) => (s ? new MediaStream(s.getTracks()) : s));
  }, []);

  const toggleVideo = useCallback(async () => {
    const pc = pcRef.current;
    const stream = localStreamRef.current;
    if (!pc || !stream) return;

    const existingTrack = stream.getVideoTracks()[0];
    if (existingTrack) {
      // Turn camera off — stop track and remove from connection
      existingTrack.stop();
      stream.removeTrack(existingTrack);
      const sender = pc.getSenders().find((s) => s.track === existingTrack);
      if (sender) pc.removeTrack(sender);
    } else {
      // Block turning camera on during screen share to prevent dual video senders
      if (screenStreamRef.current) {
        setCallError("Stop screen sharing before turning the camera on.");
        return;
      }
      // Turn camera on — get a new video track and add it
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newTrack = videoStream.getVideoTracks()[0];
        stream.addTrack(newTrack);
        pc.addTrack(newTrack, stream);
        // Set video codec preferences after adding video transceiver
        preferVideoCodecs(pc);
      } catch {
        return; // no camera or permission denied
      }
    }
    setLocalStream(new MediaStream(stream.getTracks()));
  }, []);

  const toggleAudioProcessing = useCallback(async (key: keyof AudioProcessingState) => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    setAudioProcessing((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      track.applyConstraints({ [key]: next[key] }).catch(() => {});
      return next;
    });
  }, []);

  const getFingerprint = useCallback((): string | null => {
    const sdp = pcRef.current?.localDescription?.sdp;
    if (!sdp) return null;
    const match = sdp.match(/a=fingerprint:\S+ (\S+)/);
    return match ? match[1] : null;
  }, []);

  // Auto-switch audio device when current one disappears mid-call
  useEffect(() => {
    if (!localStream) return;
    const handleDeviceChange = async () => {
      const pc = pcRef.current;
      if (!pc) return;
      const currentTrack = localStreamRef.current?.getAudioTracks()[0];
      if (!currentTrack) return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((d) => d.kind === "audioinput");
      const currentId = currentTrack.getSettings().deviceId;
      const stillExists = audioDevices.some((d) => d.deviceId === currentId);
      if (!stillExists && audioDevices.length > 0) {
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              noiseSuppression: true,
              echoCancellation: true,
              autoGainControl: true,
            },
          });
          const newTrack = newStream.getAudioTracks()[0];
          const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
          if (sender) {
            await sender.replaceTrack(newTrack);
            currentTrack.stop();
            localStreamRef.current!.removeTrack(currentTrack);
            localStreamRef.current!.addTrack(newTrack);
            setLocalStream(new MediaStream(localStreamRef.current!.getTracks()));
          }
        } catch (err) {
          console.error("device switch failed:", err);
        }
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [localStream]);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return {
    init,
    connectionState,
    chatChannel,
    fileChannel,
    remoteStream,
    localStream,
    startCall,
    endCall,
    shareScreen,
    stopScreenShare,
    screenStream,
    toggleAudio,
    toggleVideo,
    cleanup,
    getFingerprint,
    callError,
    pcRef,
    hmacKey,
    audioProcessing,
    toggleAudioProcessing,
  };
}
