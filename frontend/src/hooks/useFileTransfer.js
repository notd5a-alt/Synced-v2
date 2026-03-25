import { useState, useCallback, useEffect, useRef } from "react";

const CHUNK_SIZE = 16384; // 16 KB

export default function useFileTransfer(channel) {
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState(null);
  const pendingRef = useRef({}); // id → { name, size, mimeType, chunks[], received }
  const channelRef = useRef(channel);
  const blobUrlsRef = useRef([]);

  useEffect(() => {
    channelRef.current = channel;
    if (!channel) return;

    channel.binaryType = "arraybuffer";

    const handler = (e) => {
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "file-meta") {
            pendingRef.current[msg.id] = {
              name: msg.name,
              size: msg.size,
              mimeType: msg.mimeType,
              chunks: [],
              received: 0,
            };
            setIncoming((prev) => [
              ...prev,
              { id: msg.id, name: msg.name, size: msg.size, progress: 0, blobUrl: null },
            ]);
          } else if (msg.type === "file-end") {
            const entry = pendingRef.current[msg.id];
            if (!entry) return;
            const blob = new Blob(entry.chunks, { type: entry.mimeType });
            const blobUrl = URL.createObjectURL(blob);
            blobUrlsRef.current.push(blobUrl);
            delete pendingRef.current[msg.id];
            setIncoming((prev) =>
              prev.map((f) =>
                f.id === msg.id ? { ...f, progress: 1, blobUrl } : f
              )
            );
          }
        } catch {}
      } else {
        // Binary chunk — figure out which file it belongs to
        const ids = Object.keys(pendingRef.current);
        if (ids.length === 0) return;
        const id = ids[ids.length - 1]; // latest pending file
        const entry = pendingRef.current[id];
        entry.chunks.push(e.data);
        entry.received += e.data.byteLength;
        const progress = Math.min(entry.received / entry.size, 1);
        setIncoming((prev) =>
          prev.map((f) => (f.id === id ? { ...f, progress } : f))
        );
      }
    };

    channel.addEventListener("message", handler);
    return () => {
      channel.removeEventListener("message", handler);
      pendingRef.current = {}; // free orphaned chunks from interrupted transfers
    };
  }, [channel]);

  // Revoke blob URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, []);

  const sendFile = useCallback(async (file) => {
    const ch = channelRef.current;
    if (!ch || ch.readyState !== "open") return;

    const id = crypto.randomUUID();
    ch.send(
      JSON.stringify({
        type: "file-meta",
        id,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      })
    );

    setOutgoing({ id, name: file.name, size: file.size, bytesSent: 0 });

    const buffer = await file.arrayBuffer();
    let offset = 0;
    while (offset < buffer.byteLength) {
      // Flow control
      if (ch.bufferedAmount > 65536) {
        await new Promise((resolve) => {
          ch.bufferedAmountLowThreshold = 16384;
          ch.onbufferedamountlow = () => {
            ch.onbufferedamountlow = null;
            resolve();
          };
        });
      }
      const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
      ch.send(buffer.slice(offset, end));
      offset = end;
      setOutgoing((prev) => (prev ? { ...prev, bytesSent: offset } : null));
    }

    ch.send(JSON.stringify({ type: "file-end", id }));
    setOutgoing(null);
  }, []);

  return { incoming, outgoing, sendFile };
}
