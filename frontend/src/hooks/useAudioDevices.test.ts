import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import useAudioDevices from "./useAudioDevices";

// Mock device list
const mockDevices: MediaDeviceInfo[] = [
  { deviceId: "mic1", kind: "audioinput", label: "Built-in Mic", groupId: "g1", toJSON: () => ({}) },
  { deviceId: "mic2", kind: "audioinput", label: "USB Mic", groupId: "g2", toJSON: () => ({}) },
  { deviceId: "spk1", kind: "audiooutput", label: "Built-in Speaker", groupId: "g1", toJSON: () => ({}) },
  { deviceId: "cam1", kind: "videoinput", label: "Camera", groupId: "g3", toJSON: () => ({}) },
];

let deviceChangeHandler: (() => void) | null = null;

beforeEach(() => {
  deviceChangeHandler = null;
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      enumerateDevices: vi.fn().mockResolvedValue(mockDevices),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "devicechange") deviceChangeHandler = handler;
      }),
      removeEventListener: vi.fn(),
      getUserMedia: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
});

function makeRefs() {
  const mockTrack = {
    kind: "audio" as const,
    getSettings: () => ({ deviceId: "mic1" }),
    enabled: true,
    stop: vi.fn(),
  };
  const mockStream = {
    getAudioTracks: () => [mockTrack],
    getVideoTracks: () => [],
    getTracks: () => [mockTrack],
    removeTrack: vi.fn(),
    addTrack: vi.fn(),
  } as unknown as MediaStream;

  return {
    localStreamRef: { current: mockStream },
    pcRef: { current: null as RTCPeerConnection | null },
    remoteAudioRef: { current: null as HTMLVideoElement | null },
    setLocalStream: vi.fn(),
    localStream: mockStream,
  };
}

describe("useAudioDevices", () => {
  it("enumerates input and output devices on mount", async () => {
    const refs = makeRefs();
    const { result } = renderHook(() =>
      useAudioDevices(
        refs.localStreamRef,
        refs.pcRef,
        refs.remoteAudioRef,
        refs.setLocalStream,
        refs.localStream,
      ),
    );
    await waitFor(() => {
      expect(result.current.inputDevices).toHaveLength(2);
      expect(result.current.outputDevices).toHaveLength(1);
    });
    expect(result.current.inputDevices[0].deviceId).toBe("mic1");
    expect(result.current.inputDevices[1].deviceId).toBe("mic2");
    expect(result.current.outputDevices[0].deviceId).toBe("spk1");
  });

  it("filters out video devices", async () => {
    const refs = makeRefs();
    const { result } = renderHook(() =>
      useAudioDevices(
        refs.localStreamRef,
        refs.pcRef,
        refs.remoteAudioRef,
        refs.setLocalStream,
        refs.localStream,
      ),
    );
    await waitFor(() => {
      expect(result.current.inputDevices).toHaveLength(2);
    });
    const allIds = [
      ...result.current.inputDevices.map((d) => d.deviceId),
      ...result.current.outputDevices.map((d) => d.deviceId),
    ];
    expect(allIds).not.toContain("cam1");
  });

  it("auto-selects current input device", async () => {
    const refs = makeRefs();
    const { result } = renderHook(() =>
      useAudioDevices(
        refs.localStreamRef,
        refs.pcRef,
        refs.remoteAudioRef,
        refs.setLocalStream,
        refs.localStream,
      ),
    );
    await waitFor(() => {
      expect(result.current.selectedInput).toBe("mic1");
    });
  });

  it("generates label for unlabeled devices", async () => {
    const unlabeled: MediaDeviceInfo[] = [
      { deviceId: "abcdef123456", kind: "audioinput", label: "", groupId: "g1", toJSON: () => ({}) },
    ];
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue(unlabeled);
    const refs = makeRefs();
    const { result } = renderHook(() =>
      useAudioDevices(
        refs.localStreamRef,
        refs.pcRef,
        refs.remoteAudioRef,
        refs.setLocalStream,
        refs.localStream,
      ),
    );
    await waitFor(() => {
      expect(result.current.inputDevices).toHaveLength(1);
    });
    expect(result.current.inputDevices[0].label).toMatch(/^Mic /);
  });

  it("starts with no device error", () => {
    const refs = makeRefs();
    const { result } = renderHook(() =>
      useAudioDevices(
        refs.localStreamRef,
        refs.pcRef,
        refs.remoteAudioRef,
        refs.setLocalStream,
        refs.localStream,
      ),
    );
    expect(result.current.deviceError).toBeNull();
  });

  it("listens for devicechange events", async () => {
    const refs = makeRefs();
    renderHook(() =>
      useAudioDevices(
        refs.localStreamRef,
        refs.pcRef,
        refs.remoteAudioRef,
        refs.setLocalStream,
        refs.localStream,
      ),
    );
    expect(navigator.mediaDevices.addEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
  });
});
