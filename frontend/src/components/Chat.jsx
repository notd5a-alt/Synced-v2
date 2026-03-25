import { useState, useRef, useEffect } from "react";

export default function Chat({ messages, onSend }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className="chat">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <p className="empty">No messages yet. Say something!</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.from}`}>
            <span className="msg-sender">{m.from === "you" ? "> You" : "< Peer"}</span>
            <span className="msg-text">{m.content}</span>
            <span className="msg-time">
              {new Date(m.timestamp).toLocaleTimeString()}
            </span>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          type="text"
          placeholder="Type a message..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
        />
        <button className="btn" type="submit" disabled={!text.trim()}>
          [ SEND ]
        </button>
      </form>
    </div>
  );
}
