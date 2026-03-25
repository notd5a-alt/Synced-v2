import { useRef, type ChangeEvent, type DragEvent } from "react";
import type { IncomingFile, OutgoingFile } from "../types";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function asciiProgressBar(progress: number, width = 20): string {
  const filled = Math.round(progress * width);
  const empty = width - filled;
  return "[" + "\u2588".repeat(filled) + "\u2591".repeat(empty) + "] " + Math.round(progress * 100) + "%";
}

interface FileShareProps {
  incoming: IncomingFile[];
  outgoing: OutgoingFile | null;
  onSendFile: (file: File) => Promise<void>;
}

export default function FileShare({ incoming, outgoing, onSendFile }: FileShareProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onSendFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onSendFile(file);
  };

  return (
    <div className="file-share">
      <div
        className="drop-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        {"> "}Drop a file here or click to select
        <input
          ref={inputRef}
          type="file"
          hidden
          onChange={handleFile}
        />
      </div>

      {outgoing && (
        <div className="transfer">
          <span>Sending: {outgoing.name}</span>
          <span className="ascii-progress">
            {asciiProgressBar(outgoing.bytesSent / outgoing.size)}
          </span>
          <span className="transfer-info">
            {formatSize(outgoing.bytesSent)} / {formatSize(outgoing.size)}
          </span>
        </div>
      )}

      {incoming.map((f) => (
        <div key={f.id} className="transfer">
          <span>{f.name}</span>
          {f.blobUrl ? (
            <a href={f.blobUrl} download={f.name} className="btn small">
              [ DOWNLOAD ({formatSize(f.size)}) ]
            </a>
          ) : (
            <span className="ascii-progress">
              {asciiProgressBar(f.progress)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
