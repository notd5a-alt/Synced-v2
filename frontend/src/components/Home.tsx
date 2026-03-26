import { useState, type FormEvent } from "react";
import ThemeSelector from "./ThemeSelector";

interface HomeProps {
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
  roomError: string | null;
  themeId: string;
  onThemeChange: (id: string) => void;
}

export default function Home({ onCreateRoom, onJoinRoom, roomError, themeId, onThemeChange }: HomeProps) {
  const [joinCode, setJoinCode] = useState("");

  return (
    <div className="home">
      <img src="/logo.png" alt="Synced" className="home-logo" />
      <h1>Synced</h1>
      <p className="subtitle">Encrypted peer-to-peer communication. No accounts. No traces.</p>

      <div className="home-actions">
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

        {roomError && (
          <p className="room-error">{roomError}</p>
        )}
      </div>

      <ThemeSelector currentTheme={themeId} onSelect={onThemeChange} />
    </div>
  );
}
