import { useRef, useState, useCallback, type MutableRefObject } from "react";
import { preferVideoCodecs } from "../utils/codecConfig";
import type { SignalingHook } from "../types";

// ---------------------------------------------------------------------------
// Minimal slice of PeerState that screen sharing needs to read/write
// ---------------------------------------------------------------------------
export interface ScreenSharePeerSlice {
  remotePeerId: string;
  pc: RTCPeerConnection;
  pendingScreenTrack: boolean;
  screenVideoSender: RTCRtpSender | null;
  screenAudioSender: RTCRtpSender | null;
  remoteScreenStream: MediaStream;
}

export interface ScreenShareHook {
  /** The local screen capture stream, or null when not sharing. */
  screenStream: MediaStream | null;
  /** Capture display media and add tracks to all peer connections. */
  shareScreen: () => Promise<void>;
  /** Stop screen share and remove tracks from all peer connections. */
  stopScreenShare: () => Promise<void>;
  /**
   * Called by useWebRTC when a new peer connection is created so that an
   * in-progress share is immediately sent to the new peer.
   */
  addScreenTracksToPeer: (ps: ScreenSharePeerSlice) => Promise<void>;
  /**
   * Called by useWebRTC during endCall / cleanup to remove screen tracks
   * and clear ref state without broadcasting a signaling message.
   */
  teardown: () => void;
  /** True while getDisplayMedia() / permission prompt is pending. */
  sharingInProgressRef: MutableRefObject<boolean>;
  screenStreamRef: MutableRefObject<MediaStream | null>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export default function useScreenShare(
  signalingRef: MutableRefObject<SignalingHook>,
  peersRef: MutableRefObject<Map<string, ScreenSharePeerSlice>>,
  cleaningUpRef: MutableRefObject<boolean>,
  setCallError: (msg: string | null) => void,
  bumpRevision: () => void,
): ScreenShareHook {
  const screenStreamRef = useRef<MediaStream | null>(null);
  const sharingInProgressRef = useRef(false);

  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  // -------------------------------------------------------------------------
  // stopScreenShare — remove screen senders from all PCs, notify peers
  // -------------------------------------------------------------------------
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
  }, [peersRef, signalingRef]);

  // -------------------------------------------------------------------------
  // addScreenTracksToPeer — called when a new peer joins mid-share
  // -------------------------------------------------------------------------
  const addScreenTracksToPeer = useCallback(async (ps: ScreenSharePeerSlice) => {
    const sStream = screenStreamRef.current;
    if (!sStream) return;

    const screenTrack = sStream.getVideoTracks()[0];
    if (screenTrack) {
      if (ps.screenVideoSender) {
        try { ps.pc.removeTrack(ps.screenVideoSender); } catch { /* already removed */ }
      }
      ps.screenVideoSender = ps.pc.addTrack(screenTrack, sStream);
      preferVideoCodecs(ps.pc, "screen");

      signalingRef.current.send({
        type: "screen-sharing",
        active: true,
        trackId: screenTrack.id,
        to: ps.remotePeerId,
      });
    }

    if (ps.screenAudioSender) {
      try { ps.pc.removeTrack(ps.screenAudioSender); } catch { /* already removed */ }
      ps.screenAudioSender = null;
    }
    const audioTrack = sStream.getAudioTracks()[0];
    if (audioTrack) {
      try {
        ps.screenAudioSender = ps.pc.addTrack(audioTrack, sStream);
      } catch (err) {
        console.error("failed to add screen audio to new peer:", err);
      }
    }
  }, [signalingRef]);

  // -------------------------------------------------------------------------
  // shareScreen — get display media, add to all PCs
  // -------------------------------------------------------------------------
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
  }, [cleaningUpRef, peersRef, setCallError, signalingRef, stopScreenShare]);

  // -------------------------------------------------------------------------
  // teardown — called by useWebRTC during endCall / cleanup
  // Stops tracks and clears per-peer senders, does NOT broadcast signaling.
  // -------------------------------------------------------------------------
  const teardown = useCallback(() => {
    sharingInProgressRef.current = false;
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      screenStreamRef.current = null;
    }
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
  }, [peersRef]);

  return {
    screenStream,
    shareScreen,
    stopScreenShare,
    addScreenTracksToPeer,
    teardown,
    sharingInProgressRef,
    screenStreamRef,
  };
}
