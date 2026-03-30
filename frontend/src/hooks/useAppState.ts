import { useState, useCallback, useRef } from "react";

export type Screen = "home" | "lobby" | "session";
type ScreenAnim = "enter" | "exit" | "";

interface UseAppStateReturn {
  // Screen state machine
  screen: Screen;
  screenAnim: ScreenAnim;
  screenClass: string;
  changeScreen: (next: Screen) => void;

  // Display name & profile pic (localStorage-persisted)
  displayName: string;
  setDisplayName: React.Dispatch<React.SetStateAction<string>>;
  profilePic: string;
  setProfilePic: React.Dispatch<React.SetStateAction<string>>;

  // Room state
  mode: "host" | "join" | null;
  setMode: React.Dispatch<React.SetStateAction<"host" | "join" | null>>;
  sigUrl: string | null;
  setSigUrl: React.Dispatch<React.SetStateAction<string | null>>;
  roomCode: string | null;
  setRoomCode: React.Dispatch<React.SetStateAction<string | null>>;
  roomError: string | null;
  setRoomError: React.Dispatch<React.SetStateAction<string | null>>;

  // Session UI state
  activeTab: "chat" | "video" | "files";
  setActiveTab: React.Dispatch<React.SetStateAction<"chat" | "video" | "files">>;
  fingerprint: string | null;
  setFingerprint: React.Dispatch<React.SetStateAction<string | null>>;
  showThemePanel: boolean;
  setShowThemePanel: React.Dispatch<React.SetStateAction<boolean>>;
  deafened: boolean;
  setDeafened: React.Dispatch<React.SetStateAction<boolean>>;
  locallyMutedPeers: Set<string>;
  setLocallyMutedPeers: React.Dispatch<React.SetStateAction<Set<string>>>;

  // Unread messages
  lastSeenSeq: number;
  setLastSeenSeq: React.Dispatch<React.SetStateAction<number>>;
  unreadDismissed: boolean;
  setUnreadDismissed: React.Dispatch<React.SetStateAction<boolean>>;

  // Full reset — accepts cleanup callbacks from the calling component
  fullReset: (cleanups: FullResetCleanups) => void;

  // Ref for tracking signaling connection state
  sigConnectedRef: React.MutableRefObject<boolean>;
  nsAutoEnabledRef: React.MutableRefObject<boolean>;
}

export interface FullResetCleanups {
  cleanupNoiseSuppression: () => void;
  cleanupWebRTC: () => void;
  clearPersistentAudio: () => void;
  disconnectSignaling: () => void;
  clearChatMessages: () => void;
}

export default function useAppState(): UseAppStateReturn {
  const [screen, setScreen] = useState<Screen>("home");
  const [screenAnim, setScreenAnim] = useState<ScreenAnim>("");
  const pendingScreenRef = useRef<Screen | null>(null);

  const [displayName, setDisplayNameRaw] = useState(
    () => localStorage.getItem("synced-display-name") || "",
  );
  const [profilePic, setProfilePicRaw] = useState(
    () => localStorage.getItem("synced-profile-pic") || "",
  );

  const [mode, setMode] = useState<"host" | "join" | null>(null);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chat" | "video" | "files">("chat");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [locallyMutedPeers, setLocallyMutedPeers] = useState<Set<string>>(new Set());
  const [lastSeenSeq, setLastSeenSeq] = useState(0);
  const [unreadDismissed, setUnreadDismissed] = useState(false);

  const sigConnectedRef = useRef(false);
  const nsAutoEnabledRef = useRef(false);

  // Expose the raw setters — localStorage persistence for display name / profile pic
  // is handled by the component that owns the UI (Home.tsx writes profile pic).
  const setDisplayName = setDisplayNameRaw;
  const setProfilePic = setProfilePicRaw;

  // Animated screen transition — exit current screen, then enter the next
  const changeScreen = useCallback((next: Screen) => {
    if (screen === next || pendingScreenRef.current) return;
    setScreenAnim("exit");
    pendingScreenRef.current = next;
    setTimeout(() => {
      setScreen(next);
      setScreenAnim("enter");
      pendingScreenRef.current = null;
      setTimeout(() => setScreenAnim(""), 250);
    }, 150);
  }, [screen]);

  // Full state reset — accepts cleanup callbacks so hook stays decoupled
  const fullReset = useCallback((cleanups: FullResetCleanups) => {
    nsAutoEnabledRef.current = false;
    cleanups.cleanupNoiseSuppression();
    cleanups.cleanupWebRTC();
    cleanups.clearPersistentAudio();
    cleanups.disconnectSignaling();
    setScreen("home");
    setScreenAnim("enter");
    setTimeout(() => setScreenAnim(""), 250);
    setMode(null);
    setSigUrl(null);
    setRoomCode(null);
    setRoomError(null);
    setFingerprint(null);
    cleanups.clearChatMessages();
    setActiveTab("chat");
    setLastSeenSeq(0);
    setUnreadDismissed(false);
    setLocallyMutedPeers(new Set());
  }, []);

  const screenClass = screenAnim === "exit" ? "screen-exit" : screenAnim === "enter" ? "screen-enter" : "";

  return {
    screen,
    screenAnim,
    screenClass,
    changeScreen,
    displayName,
    setDisplayName,
    profilePic,
    setProfilePic,
    mode,
    setMode,
    sigUrl,
    setSigUrl,
    roomCode,
    setRoomCode,
    roomError,
    setRoomError,
    activeTab,
    setActiveTab,
    fingerprint,
    setFingerprint,
    showThemePanel,
    setShowThemePanel,
    deafened,
    setDeafened,
    locallyMutedPeers,
    setLocallyMutedPeers,
    lastSeenSeq,
    setLastSeenSeq,
    unreadDismissed,
    setUnreadDismissed,
    fullReset,
    sigConnectedRef,
    nsAutoEnabledRef,
  };
}
