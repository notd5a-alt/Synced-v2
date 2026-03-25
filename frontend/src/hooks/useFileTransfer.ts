import { useState, useCallback, useEffect, useRef } from "react";
import {
  signMessage,
  verifyMessage,
  signChunk,
  verifyChunk,
} from "../utils/channelAuth";
import { playFileComplete } from "../utils/sounds";
import type { IncomingFile, OutgoingFile } from "../types";

const CHUNK_SIZE = 16384; // 16 KB

interface PendingFile {
  name: string;
  size: number;
  mimeType: string;
  chunks: ArrayBuffer[];
  received: number;
  chunkIndex: number;
}

export interface FileTransferHook {
  incoming: IncomingFile[];
  outgoing: OutgoingFile | null;
  sendFile: (file: File) => Promise<void>;
}

export default function useFileTransfer(
  channel: RTCDataChannel | null,
  hmacKey: CryptoKey | null
): FileTransferHook {
  const [incoming, setIncoming] = useState<IncomingFile[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingFile | null>(null);
  const pendingRef = useRef<Record<string, PendingFile>>({});
  const channelRef = useRef(channel);
  const hmacKeyRef = useRef(hmacKey);
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    hmacKeyRef.current = hmacKey;
  }, [hmacKey]);

  useEffect(() => {
    channelRef.current = channel;
    if (!channel) return;

    channel.binaryType = "arraybuffer";

    const handler = async (e: MessageEvent) => {
      const key = hmacKeyRef.current;

      if (typeof e.data === "string") {
        try {
          let parsed: { type: string; id: string; name?: string; size?: number; mimeType?: string };
          if (key) {
            const payload = await verifyMessage(key, e.data);
            if (!payload) {
              console.warn("HMAC verification failed on file control message");
              return;
            }
            parsed = JSON.parse(payload);
          } else {
            try {
              const outer = JSON.parse(e.data);
              parsed = outer.p ? JSON.parse(outer.p) : outer;
            } catch {
              parsed = JSON.parse(e.data);
            }
          }

          if (parsed.type === "file-meta") {
            pendingRef.current[parsed.id] = {
              name: parsed.name!,
              size: parsed.size!,
              mimeType: parsed.mimeType!,
              chunks: [],
              received: 0,
              chunkIndex: 0,
            };
            setIncoming((prev) => [
              ...prev,
              { id: parsed.id, name: parsed.name!, size: parsed.size!, progress: 0, blobUrl: null },
            ]);
          } else if (parsed.type === "file-end") {
            const entry = pendingRef.current[parsed.id];
            if (!entry) return;
            const blob = new Blob(entry.chunks, { type: entry.mimeType });
            const blobUrl = URL.createObjectURL(blob);
            blobUrlsRef.current.push(blobUrl);
            delete pendingRef.current[parsed.id];
            setIncoming((prev) =>
              prev.map((f) =>
                f.id === parsed.id ? { ...f, progress: 1, blobUrl } : f
              )
            );
            playFileComplete();
          }
        } catch { /* parse error */ }
      } else {
        // Binary chunk
        const ids = Object.keys(pendingRef.current);
        if (ids.length === 0) return;
        const id = ids[ids.length - 1];
        const entry = pendingRef.current[id];

        let chunkData: ArrayBuffer;
        if (key) {
          const verified = await verifyChunk(key, e.data as ArrayBuffer, id, entry.chunkIndex);
          if (!verified) {
            console.warn("HMAC verification failed for chunk", entry.chunkIndex, "of file", id);
            return;
          }
          chunkData = verified;
        } else {
          // If data has HMAC prefix but no key, strip it; otherwise use raw
          chunkData = e.data as ArrayBuffer;
        }

        entry.chunks.push(chunkData);
        entry.received += chunkData.byteLength;
        entry.chunkIndex++;
        const progress = Math.min(entry.received / entry.size, 1);
        setIncoming((prev) =>
          prev.map((f) => (f.id === id ? { ...f, progress } : f))
        );
      }
    };

    channel.addEventListener("message", handler);
    return () => {
      channel.removeEventListener("message", handler);
      pendingRef.current = {};
    };
  }, [channel]);

  // Revoke blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  const sendFile = useCallback(async (file: File) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;
    const key = hmacKeyRef.current;

    const id = crypto.randomUUID();
    const metaMsg = JSON.stringify({
      type: "file-meta",
      id,
      name: file.name,
      size: file.size,
      mimeType: file.type || "application/octet-stream",
    });
    ch.send(key ? await signMessage(key, metaMsg) : metaMsg);

    setOutgoing({ id, name: file.name, size: file.size, bytesSent: 0 });

    const buffer = await file.arrayBuffer();
    let offset = 0;
    let chunkIndex = 0;
    while (offset < buffer.byteLength) {
      // Flow control
      if (ch.bufferedAmount > 65536) {
        await new Promise<void>((resolve) => {
          ch.bufferedAmountLowThreshold = 16384;
          ch.onbufferedamountlow = () => {
            ch.onbufferedamountlow = null;
            resolve();
          };
        });
      }
      const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
      const chunk = buffer.slice(offset, end);
      const toSend = key ? await signChunk(key, chunk, id, chunkIndex) : chunk;
      ch.send(toSend);
      offset = end;
      chunkIndex++;
      setOutgoing((prev) => (prev ? { ...prev, bytesSent: offset } : null));
    }

    const endMsg = JSON.stringify({ type: "file-end", id });
    ch.send(key ? await signMessage(key, endMsg) : endMsg);
    setOutgoing(null);
  }, []);

  return { incoming, outgoing, sendFile };
}
