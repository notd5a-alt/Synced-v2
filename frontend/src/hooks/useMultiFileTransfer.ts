import { useState, useCallback, useEffect, useRef } from "react";
import {
  signMessage,
  verifyMessage,
  signChunk,
  verifyChunk,
} from "../utils/channelAuth";
import { compressFile, decompressBlob } from "../utils/compression";
import { playFileComplete } from "../utils/sounds";
import type { IncomingFile, OutgoingFile, FileTransferStatus } from "../types";
import type { PeerInfo } from "./useWebRTC";

const CHUNK_SIZE = 16384; // 16 KB
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB

const MIME_RE = /^[\w.-]+\/[\w.+-]+$/;
const MAX_NAME_LEN = 200;

function sanitizeFileName(raw: unknown): { name: string; wasTruncated: boolean } {
  if (typeof raw !== "string" || !raw.trim()) return { name: "download", wasTruncated: false };
  let name = raw.replace(/[/\\:\0]/g, "_").trim();
  let wasTruncated = false;
  if (name.length > MAX_NAME_LEN) {
    wasTruncated = true;
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 10) {
      name = name.slice(0, MAX_NAME_LEN - (name.length - dot)) + name.slice(dot);
    } else {
      name = name.slice(0, MAX_NAME_LEN);
    }
  }
  return { name: name || "download", wasTruncated };
}

function sanitizeMimeType(raw: unknown): string {
  if (typeof raw !== "string") return "application/octet-stream";
  const t = raw.trim().toLowerCase();
  return MIME_RE.test(t) ? t : "application/octet-stream";
}

interface PendingFile {
  name: string;
  size: number;
  compressedSize: number;
  mimeType: string;
  checksum: string;
  chunks: ArrayBuffer[];
  receivedBytes: number;
  chunkIndex: number;
  status: FileTransferStatus;
  fromPeerId: string;
  lastUpdate?: number;
}

interface ActiveSend {
  id: string;
  name: string;
  originalSize: number;
  compressedBlob: Blob;
  compressedSize: number;
  checksum: string;
  mimeType: string;
  chunkIndex: number;
  byteOffset: number;
  completed: boolean;
}

export interface SentFile {
  id: string;
  name: string;
  size: number;
  compressedSize: number;
  timestamp: number;
}

export interface MultiFileTransferHook {
  incoming: IncomingFile[];
  outgoing: OutgoingFile | null;
  sentFiles: SentFile[];
  clearFiles: () => void;
  sendFile: (file: File) => Promise<void>;
  cancelTransfer: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Send chunks to a single data channel
// ---------------------------------------------------------------------------
async function sendChunksToChannel(
  ch: RTCDataChannel,
  send: ActiveSend,
  key: CryptoKey | null,
  onProgress: (bytesSent: number) => void,
): Promise<boolean> {
  let { byteOffset, chunkIndex } = send;

  while (byteOffset < send.compressedSize) {
    if (ch.readyState !== "open") {
      send.byteOffset = byteOffset;
      send.chunkIndex = chunkIndex;
      return false; // paused
    }

    if (ch.bufferedAmount > 65536) {
      ch.bufferedAmountLowThreshold = 16384;
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          ch.onbufferedamountlow = null;
          ch.removeEventListener("close", onClose);
          resolve();
        };
        const onClose = () => cleanup();
        ch.addEventListener("close", onClose, { once: true });
        ch.onbufferedamountlow = () => cleanup();
        if (ch.bufferedAmount <= 16384 || ch.readyState !== "open") cleanup();
      });
    }

    const end = Math.min(byteOffset + CHUNK_SIZE, send.compressedSize);
    const chunk = await send.compressedBlob.slice(byteOffset, end).arrayBuffer();
    const toSend = key ? await signChunk(key, chunk, send.id, chunkIndex) : chunk;
    ch.send(toSend);
    byteOffset = end;
    chunkIndex++;

    if (chunkIndex % 10 === 0 || byteOffset === send.compressedSize) {
      send.byteOffset = byteOffset;
      send.chunkIndex = chunkIndex;
      onProgress(byteOffset);
    }
  }

  // Send file-end
  const endMsg = JSON.stringify({ type: "file-end", id: send.id });
  ch.send(key ? await signMessage(key, endMsg) : endMsg);
  send.completed = true;
  return true;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export default function useMultiFileTransfer(
  peers: Map<string, PeerInfo>,
): MultiFileTransferHook {
  const [incoming, setIncoming] = useState<IncomingFile[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingFile | null>(null);
  const [sentFiles, setSentFiles] = useState<SentFile[]>([]);
  const pendingRef = useRef<Record<string, PendingFile>>({});
  const sendLockRef = useRef(false);
  const blobUrlsRef = useRef<Map<string, string>>(new Map());
  const attachedChannelsRef = useRef<Set<string>>(new Set());
  const peersRef = useRef(peers);
  peersRef.current = peers;
  // Per-peer active receive ID (each peer can send a file independently)
  const activeReceiveIdsRef = useRef<Map<string, string>>(new Map());

  // ---------------------------------------------------------------------------
  // Attach listeners to peer file channels
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const currentPeerIds = new Set(peers.keys());
    const attached = attachedChannelsRef.current;

    // Remove stale
    for (const peerId of attached) {
      if (!currentPeerIds.has(peerId)) {
        attached.delete(peerId);
        activeReceiveIdsRef.current.delete(peerId);
      }
    }

    for (const [peerId, info] of peers) {
      const ch = info.fileChannel;
      if (!ch || attached.has(peerId)) continue;
      if (ch.readyState !== "open") continue;

      attached.add(peerId);
      ch.binaryType = "arraybuffer";
      const hmacKey = info.hmacKey;

      const handler = async (e: MessageEvent) => {
        const key = hmacKey;

        if (typeof e.data === "string") {
          try {
            let parsed: Record<string, unknown>;
            if (key) {
              const payload = await verifyMessage(key, e.data);
              if (!payload) { console.warn("HMAC verification failed on file control"); return; }
              parsed = JSON.parse(payload);
            } else {
              try {
                const outer = JSON.parse(e.data);
                parsed = outer.p ? JSON.parse(outer.p) : outer;
              } catch { parsed = JSON.parse(e.data); }
            }

            const msgType = parsed.type as string;

            if (msgType === "file-meta") {
              const id = parsed.id as string;
              const size = parsed.size as number;
              const compressedSize = (parsed.compressedSize as number) || size;

              if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_SIZE ||
                  !Number.isFinite(compressedSize) || compressedSize < 0 || compressedSize > MAX_FILE_SIZE ||
                  typeof id !== "string" || !id) {
                console.warn("Invalid file metadata, rejecting transfer");
                return;
              }

              // Per-peer sequential receives
              const currentReceiveId = activeReceiveIdsRef.current.get(peerId);
              if (currentReceiveId && pendingRef.current[currentReceiveId]?.status === "receiving") {
                console.warn("Already receiving from this peer, rejecting:", id);
                return;
              }

              activeReceiveIdsRef.current.set(peerId, id);
              const checksum = (parsed.checksum as string) || "";
              const { name: safeName, wasTruncated } = sanitizeFileName(parsed.name);
              const safeMime = sanitizeMimeType(parsed.mimeType);
              pendingRef.current[id] = {
                name: safeName, size, compressedSize, mimeType: safeMime,
                checksum, chunks: [], receivedBytes: 0, chunkIndex: 0,
                status: "receiving", fromPeerId: peerId,
              };
              setIncoming((prev) => [
                ...prev,
                {
                  id, name: safeName, size, compressedSize,
                  progress: 0, blobUrl: null, status: "receiving",
                  ...(wasTruncated ? { warning: `Filename truncated to ${MAX_NAME_LEN} chars` } : {}),
                },
              ]);
            } else if (msgType === "file-end") {
              const id = parsed.id as string;
              if (activeReceiveIdsRef.current.get(peerId) === id) {
                activeReceiveIdsRef.current.delete(peerId);
              }
              const entry = pendingRef.current[id];
              if (!entry) return;

              try {
                const rawBlob = new Blob(entry.chunks, { type: entry.mimeType });
                let finalBlob: Blob;
                if (entry.checksum) {
                  try { finalBlob = await decompressBlob(rawBlob, entry.checksum); }
                  catch { finalBlob = rawBlob; }
                } else { finalBlob = rawBlob; }

                const blobUrl = URL.createObjectURL(new Blob([finalBlob], { type: entry.mimeType }));
                blobUrlsRef.current.set(id, blobUrl);
                delete pendingRef.current[id];
                setIncoming((prev) =>
                  prev.map((f) =>
                    f.id === id
                      ? { ...f, progress: 1, blobUrl, status: "completed" as FileTransferStatus, timestamp: Date.now() }
                      : f,
                  ),
                );
                playFileComplete();
              } catch (err) {
                const leakedUrl = blobUrlsRef.current.get(id);
                if (leakedUrl) { URL.revokeObjectURL(leakedUrl); blobUrlsRef.current.delete(id); }
                delete pendingRef.current[id];
                setIncoming((prev) =>
                  prev.map((f) =>
                    f.id === id
                      ? { ...f, status: "failed" as FileTransferStatus, error: (err as Error).message }
                      : f,
                  ),
                );
              }
            } else if (msgType === "file-cancel") {
              const id = parsed.id as string;
              if (activeReceiveIdsRef.current.get(peerId) === id) {
                activeReceiveIdsRef.current.delete(peerId);
              }
              delete pendingRef.current[id];
              setIncoming((prev) =>
                prev.map((f) =>
                  f.id === id
                    ? { ...f, status: "failed" as FileTransferStatus, error: "Cancelled by peer" }
                    : f,
                ),
              );
            }
          } catch { /* parse error */ }
        } else {
          // Binary chunk
          const id = activeReceiveIdsRef.current.get(peerId);
          if (!id) return;
          const entry = pendingRef.current[id];
          if (!entry || entry.status !== "receiving") return;

          let chunkData: ArrayBuffer;
          if (key) {
            const verified = await verifyChunk(key, e.data as ArrayBuffer, id, entry.chunkIndex);
            if (!verified) { console.warn("HMAC verification failed for chunk", entry.chunkIndex); return; }
            chunkData = verified;
          } else {
            chunkData = e.data as ArrayBuffer;
          }

          entry.chunks.push(chunkData);
          entry.receivedBytes += chunkData.byteLength;
          entry.chunkIndex++;

          const now = Date.now();
          if (now - (entry.lastUpdate || 0) > 100 || entry.receivedBytes >= entry.compressedSize) {
            entry.lastUpdate = now;
            const progress = Math.min(entry.receivedBytes / entry.compressedSize, 1);
            setIncoming((prev) =>
              prev.map((f) => (f.id === id ? { ...f, progress } : f)),
            );
          }
        }
      };

      ch.addEventListener("message", handler);

      const closeHandler = () => {
        attached.delete(peerId);
        activeReceiveIdsRef.current.delete(peerId);
        ch.removeEventListener("message", handler);
        ch.removeEventListener("close", closeHandler);
      };
      ch.addEventListener("close", closeHandler);
    }
  }, [peers]);

  // Revoke blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = new Map();
    };
  }, []);

  // Auto-revoke blob URLs after 5 minutes
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setIncoming((prev) =>
        prev.map((f) => {
          if (f.status === "completed" && f.blobUrl && f.timestamp && now - f.timestamp > 5 * 60 * 1000) {
            URL.revokeObjectURL(f.blobUrl);
            blobUrlsRef.current.delete(f.id);
            return { ...f, blobUrl: null };
          }
          return f;
        }),
      );
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // ---------------------------------------------------------------------------
  // sendFile — fan out to all peers in parallel
  // ---------------------------------------------------------------------------
  const sendFile = useCallback(async (file: File) => {
    if (sendLockRef.current) {
      setOutgoing((prev) => prev ? { ...prev } : {
        id: "busy", name: file.name, size: file.size,
        compressedSize: 0, bytesSent: 0, status: "failed" as FileTransferStatus,
      });
      return;
    }

    const openChannels: { ch: RTCDataChannel; key: CryptoKey | null }[] = [];
    for (const info of peersRef.current.values()) {
      const ch = info.fileChannel;
      if (ch && ch.readyState === "open") {
        openChannels.push({ ch, key: info.hmacKey });
      }
    }
    if (openChannels.length === 0) return;

    if (file.size > MAX_FILE_SIZE) {
      setOutgoing({
        id: "error", name: file.name, size: file.size,
        compressedSize: 0, bytesSent: 0, status: "failed" as FileTransferStatus,
      });
      setTimeout(() => setOutgoing(null), 5000);
      return;
    }

    sendLockRef.current = true;
    const id = crypto.randomUUID();

    try {
      // Compress
      setOutgoing({
        id, name: file.name, size: file.size,
        compressedSize: 0, bytesSent: 0, status: "compressing",
      });

      const { compressed, checksum, originalSize } = await compressFile(file);
      const compressedSize = compressed.size;

      setOutgoing({
        id, name: file.name, size: originalSize,
        compressedSize, bytesSent: 0, status: "sending",
      });

      // Send metadata to all peers
      const metaMsg = JSON.stringify({
        type: "file-meta", id, name: file.name,
        size: originalSize, mimeType: file.type || "application/octet-stream",
        compressedSize, checksum,
      });
      for (const { ch, key } of openChannels) {
        ch.send(key ? await signMessage(key, metaMsg) : metaMsg);
      }

      // Send chunks to all peers in parallel
      const sends = openChannels.map(({ ch, key }) => {
        const send: ActiveSend = {
          id, name: file.name, originalSize, compressedBlob: compressed,
          compressedSize, checksum, mimeType: file.type || "application/octet-stream",
          chunkIndex: 0, byteOffset: 0, completed: false,
        };
        return sendChunksToChannel(ch, send, key, (bytesSent) => {
          setOutgoing((prev) => prev ? { ...prev, bytesSent } : null);
        });
      });

      await Promise.all(sends);

      sendLockRef.current = false;
      setSentFiles((prev) => [...prev, {
        id, name: file.name, size: originalSize, compressedSize, timestamp: Date.now(),
      }]);
      setOutgoing(null);
      playFileComplete();
    } catch {
      sendLockRef.current = false;
      setOutgoing(null);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // cancelTransfer
  // ---------------------------------------------------------------------------
  const cancelTransfer = useCallback((id: string) => {
    // Cancel incoming
    delete pendingRef.current[id];
    setIncoming((prev) =>
      prev.map((f) => {
        if (f.id === id) {
          if (f.blobUrl) { URL.revokeObjectURL(f.blobUrl); blobUrlsRef.current.delete(id); }
          return { ...f, status: "failed" as FileTransferStatus, error: "Cancelled" };
        }
        return f;
      }),
    );

    // Notify all peers
    for (const info of peersRef.current.values()) {
      const ch = info.fileChannel;
      if (ch && ch.readyState === "open") {
        const msg = JSON.stringify({ type: "file-cancel", id });
        const send = async () => {
          ch.send(info.hmacKey ? await signMessage(info.hmacKey, msg) : msg);
        };
        send().catch(() => {});
      }
    }
  }, []);

  const clearFiles = useCallback(() => {
    // Revoke all blob URLs
    blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    blobUrlsRef.current = new Map();
    // Reset all state
    setIncoming([]);
    setOutgoing(null);
    setSentFiles([]);
    pendingRef.current = {};
    activeReceiveIdsRef.current = new Map();
    sendLockRef.current = false;
    attachedChannelsRef.current = new Set();
  }, []);

  return { incoming, outgoing, sentFiles, sendFile, cancelTransfer, clearFiles };
}
