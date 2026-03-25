import { useState, useCallback, useEffect, useRef } from "react";

export default function useDataChannel(channel) {
  const [messages, setMessages] = useState([]);
  const channelRef = useRef(channel);

  useEffect(() => {
    channelRef.current = channel;
    if (!channel) return;

    const handler = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "text") {
          setMessages((prev) => [...prev, { ...msg, from: "peer" }]);
        }
      } catch {}
    };
    channel.addEventListener("message", handler);
    return () => channel.removeEventListener("message", handler);
  }, [channel]);

  const sendMessage = useCallback(
    (text) => {
      const ch = channelRef.current;
      if (!ch || ch.readyState !== "open") return;
      const msg = { type: "text", content: text, timestamp: Date.now() };
      ch.send(JSON.stringify(msg));
      setMessages((prev) => [...prev, { ...msg, from: "you" }]);
    },
    []
  );

  const clearMessages = useCallback(() => setMessages([]), []);

  return { messages, sendMessage, clearMessages };
}
