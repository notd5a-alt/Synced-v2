import { useState, useCallback, useEffect, useRef } from "react";
import { signMessage, verifyMessage } from "../utils/channelAuth";
import { playMessageReceived, playMessageSent } from "../utils/sounds";
import type { ChatMessage, PresenceStatus, DataChannelMessage } from "../types";
import type { PeerInfo } from "./useWebRTC";

async function signAndSend(
  ch: RTCDataChannel,
  key: CryptoKey | null,
  obj: DataChannelMessage,
): Promise<void> {
  const raw = JSON.stringify(obj);
  if (key) {
    ch.send(await signMessage(key, raw));
  } else {
    ch.send(raw);
  }
}

export interface PeerAudioState {
  muted: boolean;
  deafened: boolean;
}

export interface MultiChatHook {
  messages: ChatMessage[];
  peerMsgSeq: number;
  sendMessage: (text: string) => void;
  clearMessages: () => void;
  sendReaction: (msgId: string, emoji: string) => void;
  sendReadReceipt: (msgId: string) => void;
  peerReadUpTo: string | null;
  peerTyping: boolean;
  /** Per-peer typing state */
  peersTyping: Map<string, boolean>;
  sendTyping: (isTyping: boolean) => void;
  peerPresence: PresenceStatus | null;
  /** Per-peer presence */
  peersPresence: Map<string, PresenceStatus>;
  sendPresence: (status: PresenceStatus) => void;
  /** Per-peer audio state (muted/deafened) */
  peersAudioState: Map<string, PeerAudioState>;
  sendAudioState: (muted: boolean, deafened: boolean) => void;
  /** Which peers have selectively muted their mic for us */
  peersMutedForMe: Map<string, boolean>;
  sendSelectiveMute: (peerId: string, muted: boolean) => void;
  /** Per-peer display names */
  peerNames: Map<string, string>;
  sendDisplayName: (name: string) => void;
  /** Per-peer profile pictures (data URLs) */
  peerAvatars: Map<string, string>;
  sendProfilePic: (dataUrl: string) => void;
  /** Send an image message */
  sendImage: (file: File) => Promise<void>;
  /** Send a voice message */
  sendVoice: (blob: Blob, duration: number) => Promise<void>;
}

// M7: Max message length to prevent data channel buffer overflow
const MAX_MESSAGE_LENGTH = 16000;

// Max avatar data URL size (~15KB base64 ≈ ~11KB image, sufficient for thumbnails)
const MAX_AVATAR_SIZE = 15000;

// Whitelist of safe image MIME types for avatar data URLs (prevents SVG injection)
const SAFE_AVATAR_RE = /^data:image\/(jpeg|png|gif|webp);base64,/;

export default function useMultiChat(
  peers: Map<string, PeerInfo>,
  localDisplayName?: string,
  localProfilePic?: string,
): MultiChatHook {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [peerMsgSeq, setPeerMsgSeq] = useState(0);
  const [peerReadUpTo, setPeerReadUpTo] = useState<string | null>(null);
  const [peersTyping, setPeersTyping] = useState<Map<string, boolean>>(new Map());
  const [peersPresence, setPeersPresence] = useState<Map<string, PresenceStatus>>(new Map());
  const [peersAudioState, setPeersAudioState] = useState<Map<string, PeerAudioState>>(new Map());
  const [peersMutedForMe, setPeersMutedForMe] = useState<Map<string, boolean>>(new Map());
  const [peerNames, setPeerNames] = useState<Map<string, string>>(new Map());
  const [peerAvatars, setPeerAvatars] = useState<Map<string, string>>(new Map());
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peerTypingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(false);
  // Track which channels we've attached listeners to
  const attachedChannelsRef = useRef<Set<string>>(new Set());
  const peersRef = useRef(peers);
  peersRef.current = peers;
  const localDisplayNameRef = useRef(localDisplayName);
  localDisplayNameRef.current = localDisplayName;
  const localProfilePicRef = useRef(localProfilePic);
  localProfilePicRef.current = localProfilePic;

  // ---------------------------------------------------------------------------
  // Attach message handlers to new peer channels, detach from removed ones
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const currentPeerIds = new Set(peers.keys());
    const attached = attachedChannelsRef.current;

    // Detach from removed peers
    for (const peerId of attached) {
      if (!currentPeerIds.has(peerId)) {
        attached.delete(peerId);
        // Clear typing state for removed peers
        setPeersTyping((prev) => { const next = new Map(prev); next.delete(peerId); return next; });
        setPeersPresence((prev) => { const next = new Map(prev); next.delete(peerId); return next; });
        setPeersAudioState((prev) => { const next = new Map(prev); next.delete(peerId); return next; });
        setPeersMutedForMe((prev) => { const next = new Map(prev); next.delete(peerId); return next; });
        setPeerNames((prev) => { const next = new Map(prev); next.delete(peerId); return next; });
        const timeout = peerTypingTimeoutsRef.current.get(peerId);
        if (timeout) { clearTimeout(timeout); peerTypingTimeoutsRef.current.delete(peerId); }
      }
    }

    // Attach to new peer channels
    for (const [peerId, info] of peers) {
      const ch = info.chatChannel;
      if (!ch || attached.has(peerId)) continue;
      if (ch.readyState !== "open") continue;

      attached.add(peerId);
      const hmacKey = info.hmacKey;

      const handler = async (e: MessageEvent) => {
        try {
          let parsed: DataChannelMessage;
          const key = hmacKey;
          if (key) {
            const payload = await verifyMessage(key, e.data);
            if (!payload) { console.warn("HMAC verification failed, dropping message"); return; }
            parsed = JSON.parse(payload);
          } else {
            try {
              const outer = JSON.parse(e.data);
              parsed = outer.p ? JSON.parse(outer.p) : outer;
            } catch {
              parsed = JSON.parse(e.data);
            }
          }

          if (parsed.type === "text") {
            if (typeof parsed.id !== "string" || typeof parsed.content !== "string") return;
            if (!Number.isFinite(parsed.timestamp) || parsed.timestamp < 0) return;
            setMessages((prev) => [
              ...prev,
              { ...parsed, from: peerId, reactions: {} },
            ]);
            setPeerMsgSeq((s) => s + 1);
            playMessageReceived();
          } else if (parsed.type === "image") {
            if (typeof parsed.id !== "string" || typeof parsed.data !== "string") return;
            if (parsed.data.length > 500000) return; // ~375KB max
            // Convert base64 data URL to blob URL for efficient rendering
            let imageUrl = parsed.data;
            try {
              const resp = await fetch(parsed.data);
              const blob = await resp.blob();
              imageUrl = URL.createObjectURL(blob);
            } catch { /* use data URL as fallback */ }
            setMessages((prev) => [
              ...prev,
              {
                type: "image" as const,
                id: parsed.id,
                content: "",
                timestamp: parsed.timestamp,
                from: peerId,
                reactions: {},
                imageUrl,
                imageWidth: parsed.width,
                imageHeight: parsed.height,
              },
            ]);
            setPeerMsgSeq((s) => s + 1);
            playMessageReceived();
          } else if (parsed.type === "voice") {
            if (typeof parsed.id !== "string" || typeof parsed.data !== "string") return;
            if (parsed.data.length > 1000000) return; // ~750KB max
            // Convert base64 to blob URL for playback
            let voiceBlobUrl = "";
            try {
              const resp = await fetch(parsed.data);
              const blob = await resp.blob();
              voiceBlobUrl = URL.createObjectURL(blob);
            } catch { /* skip */ }
            setMessages((prev) => [
              ...prev,
              {
                type: "voice" as const,
                id: parsed.id,
                content: "",
                timestamp: parsed.timestamp,
                from: peerId,
                reactions: {},
                voiceBlobUrl,
                voiceDuration: parsed.duration,
              },
            ]);
            setPeerMsgSeq((s) => s + 1);
            playMessageReceived();
          } else if (parsed.type === "reaction") {
            if (typeof parsed.msgId !== "string" || typeof parsed.emoji !== "string") return;
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== parsed.msgId) return m;
                const reactions = { ...m.reactions };
                if (reactions[parsed.emoji]?.includes(peerId)) {
                  reactions[parsed.emoji] = reactions[parsed.emoji].filter((f) => f !== peerId);
                  if (reactions[parsed.emoji].length === 0) delete reactions[parsed.emoji];
                } else {
                  reactions[parsed.emoji] = [...(reactions[parsed.emoji] || []), peerId];
                }
                return { ...m, reactions };
              }),
            );
          } else if (parsed.type === "read") {
            if (typeof parsed.upTo !== "string") return;
            setPeerReadUpTo(parsed.upTo);
          } else if (parsed.type === "typing") {
            if (typeof parsed.isTyping !== "boolean") return;
            setPeersTyping((prev) => {
              const next = new Map(prev);
              next.set(peerId, parsed.isTyping);
              return next;
            });
            // Auto-clear after 4s
            const existing = peerTypingTimeoutsRef.current.get(peerId);
            if (existing) clearTimeout(existing);
            if (parsed.isTyping) {
              peerTypingTimeoutsRef.current.set(peerId, setTimeout(() => {
                setPeersTyping((prev) => { const next = new Map(prev); next.set(peerId, false); return next; });
                peerTypingTimeoutsRef.current.delete(peerId);
              }, 4000));
            }
          } else if (parsed.type === "presence") {
            const validStatuses = ["online", "idle", "away"];
            if (typeof parsed.status !== "string" || !validStatuses.includes(parsed.status)) return;
            setPeersPresence((prev) => {
              const next = new Map(prev);
              next.set(peerId, parsed.status as PresenceStatus);
              return next;
            });
          } else if (parsed.type === "audio-state") {
            if (typeof parsed.muted !== "boolean" || typeof parsed.deafened !== "boolean") return;
            setPeersAudioState((prev) => {
              const next = new Map(prev);
              next.set(peerId, { muted: parsed.muted, deafened: parsed.deafened });
              return next;
            });
          } else if (parsed.type === "selective-mute") {
            if (typeof parsed.muted !== "boolean") return;
            setPeersMutedForMe((prev) => {
              const next = new Map(prev);
              next.set(peerId, parsed.muted);
              return next;
            });
          } else if (parsed.type === "display-name") {
            if (typeof parsed.name !== "string") return;
            setPeerNames((prev) => {
              const next = new Map(prev);
              next.set(peerId, parsed.name.slice(0, 32));
              return next;
            });
          } else if (parsed.type === "profile-pic") {
            if (typeof parsed.data !== "string") return;
            if (parsed.data.length > MAX_AVATAR_SIZE) return;
            if (!SAFE_AVATAR_RE.test(parsed.data)) return; // reject SVG / non-image
            setPeerAvatars((prev) => {
              const next = new Map(prev);
              next.set(peerId, parsed.data);
              return next;
            });
          }
        } catch { /* parse error */ }
      };

      ch.addEventListener("message", handler);

      // Auto-send local display name and profile pic to the new peer
      if (localDisplayNameRef.current) {
        signAndSend(ch, hmacKey, { type: "display-name", name: localDisplayNameRef.current.slice(0, 32) }).catch(() => {});
      }
      if (localProfilePicRef.current && localProfilePicRef.current.length <= MAX_AVATAR_SIZE) {
        signAndSend(ch, hmacKey, { type: "profile-pic", data: localProfilePicRef.current }).catch(() => {});
      }

      // Handle channel close — clean up
      const closeHandler = () => {
        attached.delete(peerId);
        ch.removeEventListener("message", handler);
        ch.removeEventListener("close", closeHandler);
      };
      ch.addEventListener("close", closeHandler);
    }
  }, [peers]);

  // ---------------------------------------------------------------------------
  // Fan-out sends to all open chat channels
  // ---------------------------------------------------------------------------
  const forEachChannel = useCallback(
    (fn: (ch: RTCDataChannel, key: CryptoKey | null) => void) => {
      for (const info of peersRef.current.values()) {
        const ch = info.chatChannel;
        if (ch && ch.readyState === "open") {
          fn(ch, info.hmacKey);
        }
      }
    },
    [],
  );

  const sendMessage = useCallback((text: string) => {
    const content = text.length > MAX_MESSAGE_LENGTH
      ? text.slice(0, MAX_MESSAGE_LENGTH) + "... (truncated)"
      : text;
    const msg: DataChannelMessage = {
      type: "text",
      id: crypto.randomUUID(),
      content,
      timestamp: Date.now(),
    };
    forEachChannel((ch, key) => {
      signAndSend(ch, key, msg).catch((err) =>
        console.warn("Failed to send message:", err),
      );
    });
    setMessages((prev) => [...prev, { ...msg, from: "you", reactions: {} }]);
    playMessageSent();
  }, [forEachChannel]);

  const sendReaction = useCallback((msgId: string, emoji: string) => {
    forEachChannel((ch, key) => {
      signAndSend(ch, key, { type: "reaction", msgId, emoji }).catch(() => {});
    });
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;
        const reactions = { ...m.reactions };
        if (reactions[emoji]?.includes("you")) {
          reactions[emoji] = reactions[emoji].filter((f) => f !== "you");
          if (reactions[emoji].length === 0) delete reactions[emoji];
        } else {
          reactions[emoji] = [...(reactions[emoji] || []), "you"];
        }
        return { ...m, reactions };
      }),
    );
  }, [forEachChannel]);

  const sendReadReceipt = useCallback((msgId: string) => {
    forEachChannel((ch, key) => {
      signAndSend(ch, key, { type: "read", upTo: msgId }).catch(() => {});
    });
  }, [forEachChannel]);

  const sendTyping = useCallback((isTyping: boolean) => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    if (isTyping) {
      if (!lastTypingSentRef.current) {
        forEachChannel((ch, key) => {
          signAndSend(ch, key, { type: "typing", isTyping: true }).catch(() => {});
        });
        lastTypingSentRef.current = true;
      }
      typingTimeoutRef.current = setTimeout(() => {
        forEachChannel((ch, key) => {
          signAndSend(ch, key, { type: "typing", isTyping: false }).catch(() => {});
        });
        lastTypingSentRef.current = false;
      }, 3000);
    } else {
      if (lastTypingSentRef.current) {
        forEachChannel((ch, key) => {
          signAndSend(ch, key, { type: "typing", isTyping: false }).catch(() => {});
        });
        lastTypingSentRef.current = false;
      }
    }
  }, [forEachChannel]);

  const sendPresence = useCallback((status: PresenceStatus) => {
    forEachChannel((ch, key) => {
      signAndSend(ch, key, { type: "presence", status }).catch(() => {});
    });
  }, [forEachChannel]);

  const sendAudioState = useCallback((muted: boolean, deafened: boolean) => {
    forEachChannel((ch, key) => {
      signAndSend(ch, key, { type: "audio-state", muted, deafened }).catch(() => {});
    });
  }, [forEachChannel]);

  const sendSelectiveMute = useCallback((peerId: string, muted: boolean) => {
    const info = peersRef.current.get(peerId);
    const ch = info?.chatChannel;
    if (ch && ch.readyState === "open") {
      signAndSend(ch, info.hmacKey, { type: "selective-mute", muted }).catch(() => {});
    }
  }, []);

  const sendDisplayName = useCallback((name: string) => {
    forEachChannel((ch, key) => {
      signAndSend(ch, key, { type: "display-name", name: name.slice(0, 32) }).catch(() => {});
    });
  }, [forEachChannel]);

  const sendProfilePic = useCallback((dataUrl: string) => {
    if (dataUrl.length > 70000) return; // ~50KB limit
    forEachChannel((ch, key) => {
      signAndSend(ch, key, { type: "profile-pic", data: dataUrl }).catch(() => {});
    });
  }, [forEachChannel]);

  // --- Image messages ---
  const MAX_IMAGE_DIM = 1920;
  const IMAGE_QUALITY = 0.8;

  const sendImage = useCallback(async (file: File) => {
    // Resize and compress the image
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width, h = img.height;
        if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("No canvas context")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", IMAGE_QUALITY));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
      img.src = url;
    });

    const id = crypto.randomUUID();
    const timestamp = Date.now();

    // Get dimensions from the data URL
    const tmpImg = new Image();
    const dims = await new Promise<{ width: number; height: number }>((resolve) => {
      tmpImg.onload = () => resolve({ width: tmpImg.width, height: tmpImg.height });
      tmpImg.onerror = () => resolve({ width: 0, height: 0 });
      tmpImg.src = dataUrl;
    });

    // Add to local messages immediately
    let localImageUrl = dataUrl;
    try {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      localImageUrl = URL.createObjectURL(blob);
    } catch { /* fallback to data URL */ }

    setMessages((prev) => [
      ...prev,
      {
        type: "image" as const,
        id,
        content: "",
        timestamp,
        from: "you",
        reactions: {},
        imageUrl: localImageUrl,
        imageWidth: dims.width,
        imageHeight: dims.height,
      },
    ]);
    playMessageSent();

    // Send to all peers
    forEachChannel((ch, key) => {
      signAndSend(ch, key, {
        type: "image",
        id,
        data: dataUrl,
        mimeType: "image/jpeg",
        width: dims.width,
        height: dims.height,
        timestamp,
      }).catch(() => {});
    });
  }, [forEachChannel]);

  // --- Voice messages ---
  const sendVoice = useCallback(async (blob: Blob, duration: number) => {
    // Convert blob to base64 data URL
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });

    const id = crypto.randomUUID();
    const timestamp = Date.now();
    const blobUrl = URL.createObjectURL(blob);

    // Add to local messages immediately
    setMessages((prev) => [
      ...prev,
      {
        type: "voice" as const,
        id,
        content: "",
        timestamp,
        from: "you",
        reactions: {},
        voiceBlobUrl: blobUrl,
        voiceDuration: duration,
      },
    ]);
    playMessageSent();

    // Send to all peers
    forEachChannel((ch, key) => {
      signAndSend(ch, key, {
        type: "voice",
        id,
        data: dataUrl,
        duration,
        mimeType: blob.type || "audio/webm",
        timestamp,
      }).catch(() => {});
    });
  }, [forEachChannel]);

  // Broadcast name/pic changes mid-session to all connected peers
  const prevNameRef = useRef(localDisplayName);
  const prevPicRef = useRef(localProfilePic);
  useEffect(() => {
    if (localDisplayName !== prevNameRef.current) {
      prevNameRef.current = localDisplayName;
      if (localDisplayName) sendDisplayName(localDisplayName);
    }
    if (localProfilePic !== prevPicRef.current) {
      prevPicRef.current = localProfilePic;
      if (localProfilePic) sendProfilePic(localProfilePic);
    }
  }, [localDisplayName, localProfilePic, sendDisplayName, sendProfilePic]);

  const clearMessages = useCallback(() => {
    // Revoke blob URLs to prevent memory leaks
    setMessages((prev) => {
      for (const m of prev) {
        if (m.imageUrl && m.imageUrl.startsWith("blob:")) URL.revokeObjectURL(m.imageUrl);
        if (m.voiceBlobUrl && m.voiceBlobUrl.startsWith("blob:")) URL.revokeObjectURL(m.voiceBlobUrl);
      }
      return [];
    });
    setPeerMsgSeq(0);
    setPeerReadUpTo(null);
    setPeersTyping(new Map());
    setPeersPresence(new Map());
    setPeersAudioState(new Map());
    setPeersMutedForMe(new Map());
    setPeerNames(new Map());
    setPeerAvatars(new Map());
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    for (const t of peerTypingTimeoutsRef.current.values()) clearTimeout(t);
    peerTypingTimeoutsRef.current.clear();
    lastTypingSentRef.current = false;
    attachedChannelsRef.current.clear();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      for (const t of peerTypingTimeoutsRef.current.values()) clearTimeout(t);
    };
  }, []);

  // Aggregate typing: true if any peer is typing
  const peerTyping = [...peersTyping.values()].some(Boolean);
  // Aggregate presence: pick the "best" presence (online > idle > away)
  const presenceOrder: PresenceStatus[] = ["online", "idle", "away"];
  let bestPresence: PresenceStatus | null = null;
  for (const status of peersPresence.values()) {
    if (!bestPresence || presenceOrder.indexOf(status) < presenceOrder.indexOf(bestPresence)) {
      bestPresence = status;
    }
  }

  return {
    messages,
    peerMsgSeq,
    sendMessage,
    clearMessages,
    sendReaction,
    sendReadReceipt,
    peerReadUpTo,
    peerTyping,
    peersTyping,
    sendTyping,
    peerPresence: bestPresence,
    peersPresence,
    sendPresence,
    peersAudioState,
    sendAudioState,
    peersMutedForMe,
    sendSelectiveMute,
    peerNames,
    sendDisplayName,
    peerAvatars,
    sendProfilePic,
    sendImage,
    sendVoice,
  };
}
