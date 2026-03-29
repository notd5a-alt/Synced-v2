import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useMultiChat from './useMultiChat';
import type { PeerInfo } from './useWebRTC';

// Mock channelAuth
vi.mock('../utils/channelAuth', () => ({
  signMessage: vi.fn((_key: any, raw: string) => raw),
  verifyMessage: vi.fn((_key: any, data: string) => data),
}));

// Mock sounds
vi.mock('../utils/sounds', () => ({
  playMessageReceived: vi.fn(),
  playMessageSent: vi.fn(),
}));

function createMockChannel(): RTCDataChannel {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  return {
    readyState: 'open',
    send: vi.fn(),
    addEventListener: vi.fn((event: string, handler: any) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: any) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((h) => h !== handler);
      }
    }),
    // Helper: simulate receiving a message
    _emit: (event: string, data: any) => {
      for (const h of listeners[event] || []) h(data);
    },
  } as any;
}

function createPeerInfo(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    peerId: 'peer-aaaa',
    pc: new (globalThis as any).RTCPeerConnection() as RTCPeerConnection,
    connectionState: 'connected',
    chatChannel: createMockChannel(),
    fileChannel: null,
    remoteStream: new MediaStream(),
    remoteScreenStream: new MediaStream(),
    hmacKey: null,
    ...overrides,
  };
}

describe('useMultiChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const peers = new Map<string, PeerInfo>();
    const { result } = renderHook(() => useMultiChat(peers));

    expect(result.current.messages).toEqual([]);
    expect(result.current.peerMsgSeq).toBe(0);
    expect(result.current.peerReadUpTo).toBeNull();
    expect(result.current.peerTyping).toBe(false);
    expect(result.current.peerPresence).toBeNull();
  });

  it('sendMessage fans out to all peers', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => {
      result.current.sendMessage('Hello everyone!');
    });

    // Both channels should have send called
    expect((peer1.chatChannel as any).send).toHaveBeenCalled();
    expect((peer2.chatChannel as any).send).toHaveBeenCalled();

    // Local message appears with from: "you"
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].from).toBe('you');
    expect(result.current.messages[0].content).toBe('Hello everyone!');
  });

  it('receives messages from peers with peerId attribution', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    // Simulate a message from peer-aaaa
    const ch = peer1.chatChannel as any;
    const msg = JSON.stringify({
      type: 'text',
      id: 'msg-1',
      content: 'Hi from peer A',
      timestamp: Date.now(),
    });

    await act(async () => {
      ch._emit('message', { data: msg });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].from).toBe('peer-aaaa');
    expect(result.current.messages[0].content).toBe('Hi from peer A');
    expect(result.current.peerMsgSeq).toBe(1);
  });

  it('aggregates messages from multiple peers chronologically', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch1 = peer1.chatChannel as any;
    const ch2 = peer2.chatChannel as any;

    await act(async () => {
      ch1._emit('message', {
        data: JSON.stringify({ type: 'text', id: 'msg-1', content: 'From A', timestamp: 1000 }),
      });
    });

    await act(async () => {
      ch2._emit('message', {
        data: JSON.stringify({ type: 'text', id: 'msg-2', content: 'From B', timestamp: 2000 }),
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].from).toBe('peer-aaaa');
    expect(result.current.messages[1].from).toBe('peer-bbbb');
    expect(result.current.peerMsgSeq).toBe(2);
  });

  it('tracks per-peer typing state', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch1 = peer1.chatChannel as any;

    await act(async () => {
      ch1._emit('message', {
        data: JSON.stringify({ type: 'typing', isTyping: true }),
      });
    });

    expect(result.current.peersTyping.get('peer-aaaa')).toBe(true);
    expect(result.current.peersTyping.get('peer-bbbb')).toBeUndefined();
    // Aggregate: at least one peer typing → true
    expect(result.current.peerTyping).toBe(true);
  });

  it('tracks per-peer presence', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch = peer1.chatChannel as any;

    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'presence', status: 'idle' }),
      });
    });

    expect(result.current.peersPresence.get('peer-aaaa')).toBe('idle');
    expect(result.current.peerPresence).toBe('idle');
  });

  it('sendReaction fans out to all peers and updates local state', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    // Add a local message first
    act(() => {
      result.current.sendMessage('Test');
    });

    const msgId = result.current.messages[0].id;

    act(() => {
      result.current.sendReaction(msgId, '👍');
    });

    expect(result.current.messages[0].reactions['👍']).toContain('you');
    expect((peer1.chatChannel as any).send).toHaveBeenCalledTimes(2); // message + reaction
  });

  it('clearMessages resets all state', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => { result.current.sendMessage('Hello'); });
    expect(result.current.messages).toHaveLength(1);

    act(() => { result.current.clearMessages(); });

    expect(result.current.messages).toEqual([]);
    expect(result.current.peerMsgSeq).toBe(0);
    expect(result.current.peerReadUpTo).toBeNull();
    expect(result.current.peerTyping).toBe(false);
    expect(result.current.peerPresence).toBeNull();
  });

  it('does not send to closed channels', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    (peer1.chatChannel as any).readyState = 'closed';
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => { result.current.sendMessage('Hello'); });

    expect((peer1.chatChannel as any).send).not.toHaveBeenCalled();
    // But local message still appears
    expect(result.current.messages).toHaveLength(1);
  });

  it('handles peer removal gracefully', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers1 = new Map([['peer-aaaa', peer1]]);
    const peers2 = new Map<string, PeerInfo>();

    const { result, rerender } = renderHook(
      ({ p }) => useMultiChat(p),
      { initialProps: { p: peers1 } },
    );

    const ch = peer1.chatChannel as any;
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'typing', isTyping: true }),
      });
    });

    expect(result.current.peersTyping.get('peer-aaaa')).toBe(true);

    // Remove peer
    rerender({ p: peers2 });

    // Typing state for removed peer should be cleared
    expect(result.current.peersTyping.has('peer-aaaa')).toBe(false);
  });

  it('sendTyping fans out to all peers', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => { result.current.sendTyping(true); });

    expect((peer1.chatChannel as any).send).toHaveBeenCalled();
    expect((peer2.chatChannel as any).send).toHaveBeenCalled();
  });

  it('sendPresence fans out to all peers', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => { result.current.sendPresence('away'); });

    expect((peer1.chatChannel as any).send).toHaveBeenCalled();
    const sentData = (peer1.chatChannel as any).send.mock.calls[0][0];
    expect(JSON.parse(sentData)).toMatchObject({ type: 'presence', status: 'away' });
  });

  it('receives audio-state from peer', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch = peer1.chatChannel as any;
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'audio-state', muted: true, deafened: false }),
      });
    });

    expect(result.current.peersAudioState.get('peer-aaaa')).toEqual({ muted: true, deafened: false });
  });

  it('tracks per-peer audio state independently', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch1 = peer1.chatChannel as any;
    const ch2 = peer2.chatChannel as any;

    await act(async () => {
      ch1._emit('message', {
        data: JSON.stringify({ type: 'audio-state', muted: true, deafened: false }),
      });
    });

    await act(async () => {
      ch2._emit('message', {
        data: JSON.stringify({ type: 'audio-state', muted: false, deafened: true }),
      });
    });

    expect(result.current.peersAudioState.get('peer-aaaa')).toEqual({ muted: true, deafened: false });
    expect(result.current.peersAudioState.get('peer-bbbb')).toEqual({ muted: false, deafened: true });
  });

  it('sendAudioState fans out to all peers', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => { result.current.sendAudioState(true, false); });

    expect((peer1.chatChannel as any).send).toHaveBeenCalled();
    expect((peer2.chatChannel as any).send).toHaveBeenCalled();
    const sentData = (peer1.chatChannel as any).send.mock.calls[0][0];
    expect(JSON.parse(sentData)).toMatchObject({ type: 'audio-state', muted: true, deafened: false });
  });

  it('clears audio state on peer removal', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers1 = new Map([['peer-aaaa', peer1]]);
    const peers2 = new Map<string, PeerInfo>();

    const { result, rerender } = renderHook(
      ({ p }) => useMultiChat(p),
      { initialProps: { p: peers1 } },
    );

    const ch = peer1.chatChannel as any;
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'audio-state', muted: true, deafened: true }),
      });
    });

    expect(result.current.peersAudioState.get('peer-aaaa')).toEqual({ muted: true, deafened: true });

    rerender({ p: peers2 });

    expect(result.current.peersAudioState.has('peer-aaaa')).toBe(false);
  });

  it('clearMessages resets audio state', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch = peer1.chatChannel as any;
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'audio-state', muted: true, deafened: false }),
      });
    });

    expect(result.current.peersAudioState.size).toBe(1);

    act(() => { result.current.clearMessages(); });

    expect(result.current.peersAudioState.size).toBe(0);
  });

  it('receives selective-mute from peer', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiChat(peers));

    const ch = peer1.chatChannel as any;
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'selective-mute', muted: true }),
      });
    });

    expect(result.current.peersMutedForMe.get('peer-aaaa')).toBe(true);
  });

  it('sendSelectiveMute sends only to targeted peer', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiChat(peers));

    act(() => { result.current.sendSelectiveMute('peer-aaaa', true); });

    expect((peer1.chatChannel as any).send).toHaveBeenCalled();
    expect((peer2.chatChannel as any).send).not.toHaveBeenCalled();
    const sentData = (peer1.chatChannel as any).send.mock.calls[0][0];
    expect(JSON.parse(sentData)).toMatchObject({ type: 'selective-mute', muted: true });
  });

  it('clears peersMutedForMe on peer removal', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers1 = new Map([['peer-aaaa', peer1]]);
    const peers2 = new Map<string, PeerInfo>();

    const { result, rerender } = renderHook(
      ({ p }) => useMultiChat(p),
      { initialProps: { p: peers1 } },
    );

    const ch = peer1.chatChannel as any;
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'selective-mute', muted: true }),
      });
    });

    expect(result.current.peersMutedForMe.get('peer-aaaa')).toBe(true);

    rerender({ p: peers2 });

    expect(result.current.peersMutedForMe.has('peer-aaaa')).toBe(false);
  });
});
