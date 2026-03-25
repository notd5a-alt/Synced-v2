import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import type { SignalingState, SignalingMessage, SignalingHook } from "../types";

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_DELAY = 1000; // ms, doubles each attempt, max 30s

export default function useSignaling(url: string | null): SignalingHook {
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef<((msg: SignalingMessage) => void) | null>(null);
  const queueRef = useRef<SignalingMessage[]>([]); // buffer messages arriving before handler is set
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const urlRef = useRef(url);
  const [state, setState] = useState<SignalingState>("closed");

  urlRef.current = url;

  const wasEverOpenRef = useRef(false);

  const createSocketRef = useRef<(() => void) | null>(null);
  createSocketRef.current = () => {
    const currentUrl = urlRef.current;
    if (!currentUrl) return;
    if (wsRef.current) return;
    setState(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");

    const ws = new WebSocket(currentUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[signaling] open:", currentUrl);
      setState("open");
      wasEverOpenRef.current = true;
      reconnectAttemptRef.current = 0;
    };
    ws.onclose = (event: CloseEvent) => {
      console.log("[signaling] closed: code=%d reason=%s", event.code, event.reason);
      wsRef.current = null;

      // Don't reconnect if we intentionally closed or were replaced by a new
      // connection for the same role (backend sends 4001 on replacement)
      if (intentionalCloseRef.current || event.code === 4001) {
        setState("closed");
        return;
      }

      // Only auto-reconnect if the connection was previously open
      // (prevents phantom reconnects from failed initial connections)
      if (wasEverOpenRef.current && reconnectAttemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        const delay = Math.min(
          BASE_DELAY * Math.pow(2, reconnectAttemptRef.current),
          30000
        );
        setState("reconnecting");
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptRef.current++;
          createSocketRef.current?.();
        }, delay);
      } else if (!wasEverOpenRef.current) {
        setState("closed");
      } else {
        setState("closed");
      }
    };
    ws.onerror = () => {
      // onclose always fires after onerror
    };
    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data) as SignalingMessage;
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
    createSocketRef.current?.();
  }, []);

  const send = useCallback((obj: SignalingMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    wasEverOpenRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    reconnectAttemptRef.current = 0;
    wsRef.current?.close();
    wsRef.current = null;
    queueRef.current = [];
    setState("closed");
  }, []);

  const onMessage = useCallback((handler: (msg: SignalingMessage) => void) => {
    onMessageRef.current = handler;
    // Flush any buffered messages
    const queued = queueRef.current;
    queueRef.current = [];
    queued.forEach((msg) => handler(msg));
  }, []);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  return useMemo(
    () => ({ connect, send, disconnect, onMessage, state }),
    [connect, send, disconnect, onMessage, state]
  );
}
