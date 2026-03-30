// Shared type definitions for Synced frontend

// --- Signaling ---

export type SignalingState = "closed" | "connecting" | "open" | "reconnecting";

export interface PeerMeta {
  name?: string;
  avatar?: string;
}

export type SignalingMessage =
  | { type: "offer"; sdp?: string; candidate?: never; from?: string; to?: string }
  | { type: "answer"; sdp?: string; candidate?: never; from?: string; to?: string }
  | { type: "ice-candidate"; candidate?: RTCIceCandidateInit; sdp?: never; from?: string; to?: string }
  | { type: "peer-joined"; peerId: string; meta?: PeerMeta }
  | { type: "peer-disconnected"; peerId: string }
  | { type: "assigned-id"; peerId: string }
  | { type: "room-state"; peers: string[]; peerMeta?: Record<string, PeerMeta> }
  | { type: "peer-meta"; peerId: string; meta: PeerMeta }
  | { type: "set-meta"; name?: string; avatar?: string }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "screen-sharing"; active: boolean; trackId?: string; from?: string; to?: string };

export interface SignalingHook {
  connect: () => void;
  send: (obj: SignalingMessage) => void;
  disconnect: () => void;
  onMessage: (handler: (msg: SignalingMessage) => void) => void;
  state: SignalingState;
  peerId: string | null;
  roomPeers: string[];
  peerMetas: Map<string, PeerMeta>;
  debugLog: string[];
  addLog: (msg: string) => void;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
}

// --- Connection monitoring ---

export type ConnectionQuality = "excellent" | "good" | "poor" | "critical";
export type ConnectionType = "direct" | "relay";

export interface ConnectionStats {
  rtt: number | null;
  packetLoss: number | null;
  bitrate: number | null;
  codec: string | null;
  resolution: string | null;
  fps: number | null;
}

// --- Audio processing ---

export interface AudioProcessingState {
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

// --- Chat ---

export interface ChatMessage {
  type: "text" | "image" | "voice";
  id: string;
  content: string;
  timestamp: number;
  /** "you" for local messages, peerId string for remote messages */
  from: string;
  reactions: Record<string, string[]>;
  // Image-specific
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  // Voice-specific
  voiceBlobUrl?: string;   // object URL for playback
  voiceDuration?: number;  // seconds
}

export type PresenceStatus = "online" | "idle" | "away";

export type DataChannelMessage =
  | { type: "text"; id: string; content: string; timestamp: number }
  | { type: "image"; id: string; data: string; mimeType: string; width: number; height: number; timestamp: number }
  | { type: "voice"; id: string; data: string; duration: number; mimeType: string; timestamp: number }
  | { type: "reaction"; msgId: string; emoji: string }
  | { type: "read"; upTo: string }
  | { type: "typing"; isTyping: boolean }
  | { type: "presence"; status: PresenceStatus }
  | { type: "audio-state"; muted: boolean; deafened: boolean }
  | { type: "selective-mute"; muted: boolean }
  | { type: "display-name"; name: string }
  | { type: "profile-pic"; data: string };

// --- File transfer ---

export type FileTransferStatus = "compressing" | "sending" | "receiving" | "paused" | "completed" | "failed";

export interface IncomingFile {
  id: string;
  name: string;
  size: number;
  compressedSize: number;
  progress: number;
  blobUrl: string | null;
  status: FileTransferStatus;
  error?: string;
  warning?: string;
  timestamp?: number;  // M4: Completion time for auto-revoke of blob URLs
}

export interface OutgoingFile {
  id: string;
  name: string;
  size: number;
  compressedSize: number;
  bytesSent: number;
  status: FileTransferStatus;
}

export type FileControlMessage =
  | { type: "file-meta"; id: string; name: string; size: number; mimeType: string; compressedSize: number; checksum: string }
  | { type: "file-end"; id: string }
  | { type: "file-resume-req"; id: string; receivedBytes: number; chunkIndex: number }
  | { type: "file-resume-ack"; id: string; resumeFromByte: number; resumeFromChunk: number }
  | { type: "file-cancel"; id: string };
