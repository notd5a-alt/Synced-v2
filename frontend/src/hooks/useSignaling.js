import { useRef, useState, useCallback, useEffect, useMemo } from "react";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY = 1000; // ms, doubles each attempt, max 30s

export default function useSignaling(url) {
  const wsRef = useRef(null);
  const onMessageRef = useRef(null);
  const queueRef = useRef([]); // buffer messages arriving before handler is set
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const urlRef = useRef(url);
  const [state, setState] = useState("closed");

  urlRef.current = url;

  const createSocketRef = useRef(null);
  createSocketRef.current = () => {
    const currentUrl = urlRef.current;
    if (!currentUrl) return;
    if (wsRef.current) return;
    setState(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");

    const ws = new WebSocket(currentUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setState("open");
      reconnectAttemptRef.current = 0;
    };
    ws.onclose = () => {
      wsRef.current = null;

      if (intentionalCloseRef.current) {
        setState("closed");
        return;
      }

      // Auto-reconnect with exponential backoff
      if (reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(
          BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
          30000
        );
        setState("reconnecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptRef.current++;
          createSocketRef.current();
        }, delay);
      } else {
        setState("closed");
      }
    };
    ws.onerror = () => {
      // onclose always fires after onerror
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (onMessageRef.current) {
          onMessageRef.current(msg);
        } else {
          queueRef.current.push(msg);
        }
      } catch {
        // invalid JSON
      }
    };
  };

  const connect = useCallback(() => {
    intentionalCloseRef.current = false;
    reconnectAttemptRef.current = 0;
    createSocketRef.current();
  }, []);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    wsRef.current?.close();
    wsRef.current = null;
    queueRef.current = [];
    setState("closed");
  }, []);

  const onMessage = useCallback((handler) => {
    onMessageRef.current = handler;
    // Flush any buffered messages
    const queued = queueRef.current;
    queueRef.current = [];
    queued.forEach((msg) => handler(msg));
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return useMemo(
    () => ({ connect, send, disconnect, onMessage, state }),
    [connect, send, disconnect, onMessage, state]
  );
}
