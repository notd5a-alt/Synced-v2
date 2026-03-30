import { useState, useRef, useEffect, useCallback, type FormEvent } from "react";
import type { ChatMessage } from "../types";
import VoiceMessage from "./VoiceMessage";

const REACTION_EMOJIS = ["\u{1F44D}", "\u{2764}\u{FE0F}", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}"];

interface ChatProps {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onCommand: (cmd: string) => void;
  cmdOutput: string | null;
  onReaction: (msgId: string, emoji: string) => void;
  onMarkRead: (msgId: string) => void;
  onTyping: (isTyping: boolean) => void;
  peerReadUpTo: string | null;
  peerTyping: boolean;
  peerNames?: Map<string, string>;
  peerAvatars?: Map<string, string>;
  localProfilePic?: string;
  onSendImage?: (file: File) => Promise<void>;
  onSendVoice?: (blob: Blob, duration: number) => Promise<void>;
  localStream?: MediaStream | null;
}

export default function Chat({
  messages,
  onSend,
  onCommand,
  cmdOutput,
  onReaction,
  onMarkRead,
  onTyping,
  peerReadUpTo,
  peerTyping,
  peerNames,
  peerAvatars,
  localProfilePic,
  onSendImage,
  onSendVoice,
  localStream,
}: ChatProps) {
  const [text, setText] = useState("");
  const [pickerMsgId, setPickerMsgId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastReadRef = useRef<string | null>(null);
  const seenMsgIds = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStartRef = useRef(0);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-send read receipts for new peer messages
  useEffect(() => {
    const lastPeer = [...messages].reverse().find((m) => m.from !== "you");
    if (lastPeer && lastPeer.id !== lastReadRef.current) {
      lastReadRef.current = lastPeer.id;
      onMarkRead(lastPeer.id);
    }
  }, [messages, onMarkRead]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      onCommand(trimmed);
    } else {
      onSend(trimmed);
    }
    setText("");
    onTyping(false);
  };

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setText(e.target.value);
    onTyping(true);
  };

  // --- Image handling ---
  const handleImagePick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onSendImage) return;
    try { await onSendImage(file); } catch (err) { console.error("Failed to send image:", err); }
    e.target.value = "";
  }, [onSendImage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (!onSendImage) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) onSendImage(file).catch((err) => console.error("Failed to send pasted image:", err));
        return;
      }
    }
  }, [onSendImage]);

  // --- Voice recording ---
  const startRecording = useCallback(async () => {
    if (!onSendVoice) return;

    // Get a mic stream — use existing localStream's audio track if available, otherwise request new
    let micStream: MediaStream;
    const existingAudioTrack = localStream?.getAudioTracks()[0];
    if (existingAudioTrack && existingAudioTrack.readyState === "live") {
      micStream = new MediaStream([existingAudioTrack]);
    } else {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.error("Mic access denied:", err);
        return;
      }
    }

    // Pick a supported mime type
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";

    const recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
    recChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recChunksRef.current, { type: recorder.mimeType });
      const duration = (Date.now() - recStartRef.current) / 1000;
      if (duration > 0.5 && blob.size > 0) {
        onSendVoice(blob, duration);
      }
      recChunksRef.current = [];
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      setRecording(false);
      setRecordingTime(0);
    };

    recorder.start(100); // collect data every 100ms
    recorderRef.current = recorder;
    recStartRef.current = Date.now();
    setRecording(true);
    setRecordingTime(0);

    // Update timer display
    recTimerRef.current = setInterval(() => {
      setRecordingTime((Date.now() - recStartRef.current) / 1000);
    }, 200);
  }, [onSendVoice, localStream]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.ondataavailable = null;
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    recChunksRef.current = [];
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    setRecording(false);
    setRecordingTime(0);
  }, []);

  // Clean up recorder on unmount
  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    };
  }, []);

  const formatRecTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  // Find the index of the last "you" message that the peer has read
  const lastReadIdx = peerReadUpTo
    ? messages.findIndex((m) => m.id === peerReadUpTo)
    : -1;

  return (
    <div className="chat" onPaste={handlePaste}>
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <p className="empty">No messages yet. Say something!</p>
        )}
        {messages.map((m, i) => {
          const isNew = !seenMsgIds.current.has(m.id);
          if (isNew) seenMsgIds.current.add(m.id);
          return (
          <div
            key={m.id || i}
            className={`msg ${m.from === "you" ? "you" : "peer"}${isNew ? " msg-animate" : ""}`}
            onClick={() =>
              setPickerMsgId(pickerMsgId === m.id ? null : m.id)
            }
          >
            <span className="msg-sender">
              {m.from === "you" ? (
                <>
                  {localProfilePic && <img src={localProfilePic} alt="" className="msg-avatar" />}
                  {"> You"}
                </>
              ) : (
                <>
                  {peerAvatars?.get(m.from) && <img src={peerAvatars.get(m.from)} alt="" className="msg-avatar" />}
                  {`< ${peerNames?.get(m.from) || m.from.slice(0, 8)}`}
                </>
              )}
            </span>

            {/* Message body — varies by type */}
            {m.type === "text" && (
              <span className="msg-text">{m.content}</span>
            )}
            {m.type === "image" && m.imageUrl && (
              <div className="msg-image-wrap">
                <img
                  src={m.imageUrl}
                  alt="Shared image"
                  className="msg-image"
                  style={{
                    maxWidth: Math.min(m.imageWidth || 300, 300),
                    aspectRatio: m.imageWidth && m.imageHeight
                      ? `${m.imageWidth}/${m.imageHeight}`
                      : undefined,
                  }}
                  onClick={(e) => { e.stopPropagation(); setLightboxUrl(m.imageUrl!); }}
                />
              </div>
            )}
            {m.type === "voice" && m.voiceBlobUrl && (
              <VoiceMessage
                blobUrl={m.voiceBlobUrl}
                duration={m.voiceDuration || 0}
                userColor={m.from === "you" ? undefined : undefined}
              />
            )}

            <span className="msg-time">
              {new Date(m.timestamp).toLocaleTimeString()}
            </span>
            {/* Reactions display */}
            {m.reactions && Object.keys(m.reactions).length > 0 && (
              <div className="msg-reactions">
                {Object.entries(m.reactions).map(([emoji, users]) => (
                  <button
                    key={emoji}
                    className={`reaction-badge ${
                      users.includes("you") ? "mine" : ""
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReaction(m.id, emoji);
                    }}
                  >
                    {emoji} {users.length}
                  </button>
                ))}
              </div>
            )}
            {/* Reaction picker */}
            {pickerMsgId === m.id && (
              <div className="reaction-picker">
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    className="reaction-pick"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReaction(m.id, emoji);
                      setPickerMsgId(null);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            {/* Read receipt — show on the exact message the peer has read up to */}
            {m.from === "you" && i === lastReadIdx && (
              <span className="msg-read">SEEN</span>
            )}
          </div>
          );
        })}
      </div>
      {cmdOutput && (
        <pre className="cmd-output">{cmdOutput}</pre>
      )}
      {peerTyping && (
        <div className="typing-indicator">
          <span>Peer is typing</span>
          <span className="typing-dots">...</span>
        </div>
      )}

      {/* Image lightbox */}
      {lightboxUrl && (
        <div className="chat-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Full size" />
          <span className="lightbox-close">[ X ]</span>
        </div>
      )}

      {/* Input area */}
      {recording ? (
        <div className="chat-input recording-bar">
          <span className="rec-indicator">REC</span>
          <span className="rec-time">{formatRecTime(recordingTime)}</span>
          <button className="btn" type="button" onClick={cancelRecording}>
            [ CANCEL ]
          </button>
          <button className="btn" type="button" onClick={stopRecording}>
            [ SEND ]
          </button>
        </div>
      ) : (
        <form className="chat-input" onSubmit={submit}>
          {onSendImage && (
            <>
              <button
                className="btn chat-media-btn"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Send image"
              >
                IMG
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleImagePick}
              />
            </>
          )}
          {onSendVoice && (
            <button
              className="btn chat-media-btn"
              type="button"
              onClick={startRecording}
              title="Record voice message"
            >
              MIC
            </button>
          )}
          <input
            type="text"
            placeholder="Type a message..."
            value={text}
            onChange={handleInput}
            autoFocus
          />
          <button className="btn" type="submit" disabled={!text.trim()}>
            [ SEND ]
          </button>
        </form>
      )}
    </div>
  );
}
