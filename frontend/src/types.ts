// Shared type definitions for GhostChat frontend

// --- Signaling ---

export type SignalingState = "closed" | "connecting" | "open" | "reconnecting";

export interface SignalingMessage {
  type: "offer" | "answer" | "ice-candidate" | "peer-joined" | "peer-disconnected";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export interface SignalingHook {
  connect: () => void;
  send: (obj: SignalingMessage) => void;
  disconnect: () => void;
  onMessage: (handler: (msg: SignalingMessage) => void) => void;
  state: SignalingState;
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
  type: "text";
  id: string;
  content: string;
  timestamp: number;
  from: "you" | "peer";
  reactions: Record<string, string[]>;
}

export type PresenceStatus = "online" | "idle" | "away";

export type DataChannelMessage =
  | { type: "text"; id: string; content: string; timestamp: number }
  | { type: "reaction"; msgId: string; emoji: string }
  | { type: "read"; upTo: string }
  | { type: "typing"; isTyping: boolean }
  | { type: "presence"; status: PresenceStatus };

// --- File transfer ---

export interface IncomingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  blobUrl: string | null;
}

export interface OutgoingFile {
  id: string;
  name: string;
  size: number;
  bytesSent: number;
}

export type FileControlMessage =
  | { type: "file-meta"; id: string; name: string; size: number; mimeType: string }
  | { type: "file-end"; id: string };
