import { useState, useRef, useCallback, useEffect, type FormEvent } from "react";
import ThemeSelector from "./ThemeSelector";
import {
  getServerMode,
  setServerMode,
  getRemoteUrl,
  getApiBaseUrl,
  DEFAULT_REMOTE_URL,
  type ServerMode,
} from "../config";

const DISPLAY_NAME_KEY = "synced-display-name";

interface HomeProps {
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
  roomError: string | null;
  themeId: string;
  onThemeChange: (id: string) => void;
  canvasBgId: string;
  onCanvasBgChange: (id: string) => void;
  uiScale: number;
  onUiScaleChange: (scale: number) => void;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  profilePic: string;
  onProfilePicChange: (dataUrl: string) => void;
}

const ROOM_CODE_RE = /^[A-HJKL-NP-Z2-9]{6}$/;
const MAX_AVATAR_SIZE = 128;
const AVATAR_QUALITY = 0.7;

function resizeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = MAX_AVATAR_SIZE;
      canvas.height = MAX_AVATAR_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("No canvas context")); return; }
      // Crop to square (center)
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, MAX_AVATAR_SIZE, MAX_AVATAR_SIZE);
      resolve(canvas.toDataURL("image/jpeg", AVATAR_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load image")); };
    img.src = url;
  });
}

export default function Home({ onCreateRoom, onJoinRoom, roomError, themeId, onThemeChange, canvasBgId, onCanvasBgChange, uiScale, onUiScaleChange, displayName, onDisplayNameChange, profilePic, onProfilePicChange }: HomeProps) {
  const [joinCode, setJoinCode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [serverMode, setServerModeState] = useState<ServerMode>(getServerMode);
  const [roomPreview, setRoomPreview] = useState<{
    peerCount: number;
    maxPeers: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-fetch room info when a valid 6-char code is entered
  useEffect(() => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    const upper = joinCode.toUpperCase().trim();
    if (!ROOM_CODE_RE.test(upper)) {
      setRoomPreview(null);
      return;
    }
    setPreviewLoading(true);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${getApiBaseUrl()}/api/rooms/${upper}`);
        const data = await res.json();
        if (data.exists) {
          setRoomPreview({
            peerCount: data.peer_count || 0,
            maxPeers: data.max_peers || 8,
          });
        } else {
          setRoomPreview(null);
        }
      } catch {
        setRoomPreview(null);
      }
      setPreviewLoading(false);
    }, 300); // debounce
    return () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinCode]);

  const handleAvatarPick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file);
      onProfilePicChange(dataUrl);
      localStorage.setItem("synced-profile-pic", dataUrl);
    } catch (err) {
      console.error("Failed to process avatar:", err);
    }
    // Reset so the same file can be re-selected
    e.target.value = "";
  }, [onProfilePicChange]);

  const handleAvatarRemove = useCallback(() => {
    onProfilePicChange("");
    localStorage.removeItem("synced-profile-pic");
  }, [onProfilePicChange]);

  const handleModeChange = (mode: ServerMode) => {
    setServerModeState(mode);
    setServerMode(mode);
  };

  return (
    <div className="home">
      <img src="/logo.png" alt="Synced" className="home-logo" />
      <h1>Synced</h1>
      <p className="subtitle">Encrypted peer-to-peer communication. No accounts. No traces.</p>

      <div className="home-actions">
        <div className="profile-row">
          <button
            className="avatar-picker"
            onClick={() => fileInputRef.current?.click()}
            title={profilePic ? "Change profile picture" : "Add profile picture"}
          >
            {profilePic ? (
              <img src={profilePic} alt="Avatar" className="avatar-preview" />
            ) : (
              <span className="avatar-placeholder">+</span>
            )}
          </button>
          {profilePic && (
            <button className="btn small avatar-remove" onClick={handleAvatarRemove} title="Remove picture">
              X
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleAvatarPick}
          />
          <input
            type="text"
            className="name-input"
            placeholder="Your name"
            value={displayName}
            onChange={(e) => {
              const name = e.target.value.slice(0, 32);
              onDisplayNameChange(name);
              localStorage.setItem(DISPLAY_NAME_KEY, name);
            }}
            maxLength={32}
          />
        </div>

        <button className="btn primary" onClick={onCreateRoom}>
          Create Room
        </button>

        <div className="divider">// // // // //</div>

        <form
          className="join-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (joinCode.trim()) onJoinRoom(joinCode.trim());
          }}
        >
          <input
            type="text"
            placeholder="Enter room code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            style={{ textTransform: "uppercase", letterSpacing: "0.15em" }}
          />
          <button className="btn" type="submit" disabled={!joinCode.trim()}>
            [ JOIN ]
          </button>
        </form>

        {/* Room preview — shows who's in the room before joining */}
        {previewLoading && joinCode.length === 6 && (
          <div className="room-preview">
            <span className="room-preview-loading">Checking room...</span>
          </div>
        )}
        {roomPreview && !previewLoading && (
          <div className="room-preview">
            <div className="room-preview-header">
              {roomPreview.peerCount} / {roomPreview.maxPeers} peers in room
            </div>
          </div>
        )}

        {roomError && (
          <p className="room-error">{roomError}</p>
        )}
      </div>

      <button
        className="btn small server-settings-toggle"
        onClick={() => setShowSettings((s) => !s)}
      >
        {showSettings ? "[ HIDE SERVER ]" : "[ SERVER ]"}
      </button>

      {showSettings && (
        <div className="server-settings">
          <div className="server-mode-toggle">
            <button
              className={`btn small ${serverMode === "local" ? "active" : ""}`}
              onClick={() => handleModeChange("local")}
            >
              LOCAL
            </button>
            <button
              className={`btn small ${serverMode === "remote" ? "active" : ""}`}
              onClick={() => handleModeChange("remote")}
            >
              REMOTE
            </button>
          </div>

          {serverMode === "local" && (
            <p className="server-hint">
              Using local backend (localhost). Both peers must be on the same network.
            </p>
          )}

          {serverMode === "remote" && (
            <p className="server-hint">
              Signaling via {DEFAULT_REMOTE_URL}
            </p>
          )}
        </div>
      )}

      <ThemeSelector currentTheme={themeId} onSelect={onThemeChange} currentCanvasBg={canvasBgId} onCanvasBgSelect={onCanvasBgChange} currentScale={uiScale} onScaleSelect={onUiScaleChange} />
    </div>
  );
}
