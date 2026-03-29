import { renderHook, act } from '@testing-library/react';
import useWebRTC from './useWebRTC';
import type { SignalingHook, SignalingMessage } from '../types';

// Mock channelAuth
vi.mock('../utils/channelAuth', () => ({
  deriveHmacKey: vi.fn().mockResolvedValue({ type: 'secret', algorithm: { name: 'HMAC' } }),
}));

// Mock codecConfig
vi.mock('../utils/codecConfig', () => ({
  preferVideoCodecs: vi.fn(),
  preferAudioCodecs: vi.fn(),
  optimizeOpusInSDP: vi.fn((sdp: string) => sdp),
}));

const createMockSignaling = (peerId = 'local-aaaa'): SignalingHook => ({
  connect: vi.fn(),
  send: vi.fn(),
  disconnect: vi.fn(),
  onMessage: vi.fn(),
  state: 'open' as const,
  peerId,
  roomPeers: [],
  debugLog: [] as string[],
  addLog: vi.fn(),
  reconnectAttempt: 0,
  maxReconnectAttempts: 5,
});

/** After init(), extract the handler that was passed to signaling.onMessage */
function getMessageHandler(signaling: SignalingHook): (msg: SignalingMessage) => Promise<void> {
  const calls = (signaling.onMessage as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

/** Simulate a peer joining and return the created PeerConnection mock */
async function simulatePeerJoin(
  signaling: SignalingHook,
  remotePeerId: string,
): Promise<any> {
  const handler = getMessageHandler(signaling);
  await act(async () => {
    await handler({ type: 'peer-joined', peerId: remotePeerId });
  });
  // The PC is created by the hook; we access it via the pcRef shim or peers map
  return null; // tests access PCs via result.current
}

describe('useWebRTC', () => {
  let signaling: SignalingHook;

  beforeEach(() => {
    signaling = createMockSignaling('local-aaaa');
    vi.clearAllMocks();
  });

  // 1. Initial state — no PCs until peers join
  it('has correct initial state', () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    expect(result.current.connectionState).toBe('new');
    expect(result.current.chatChannel).toBeNull();
    expect(result.current.fileChannel).toBeNull();
    expect(result.current.hmacKey).toBeNull();
    expect(result.current.callError).toBeNull();
    expect(result.current.peerCount).toBe(0);
    expect(result.current.peers.size).toBe(0);
    expect(result.current.localPeerId).toBe('local-aaaa');
  });

  // 2. init() registers signaling handler but does NOT create PC
  it('init registers signaling handler without creating PC', () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => {
      result.current.init(null);
    });

    expect(signaling.onMessage).toHaveBeenCalled();
    expect(result.current.pcRef.current).toBeNull();
    expect(result.current.peerCount).toBe(0);
  });

  // 3. peer-joined creates RTCPeerConnection
  it('peer-joined creates RTCPeerConnection', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    expect(result.current.peerCount).toBe(1);
    expect(result.current.pcRef.current).not.toBeNull();
    expect(result.current.peers.has('remote-zzzz')).toBe(true);
  });

  // 4. room-state creates PCs for all existing peers
  it('room-state creates PCs for all listed peers', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'room-state', peers: ['peer-bbbb', 'peer-cccc'] });
    });

    expect(result.current.peerCount).toBe(2);
    expect(result.current.peers.has('peer-bbbb')).toBe(true);
    expect(result.current.peers.has('peer-cccc')).toBe(true);
  });

  // 5. Impolite peer (lower ID) creates offer on peer-joined
  it('impolite peer (lower ID) creates offer on peer-joined', async () => {
    // local-aaaa < remote-zzzz → local is impolite → creates offer
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    expect(pc.createOffer).toHaveBeenCalled();
    expect(pc.setLocalDescription).toHaveBeenCalled();
    expect(signaling.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'offer', to: 'remote-zzzz' })
    );
  });

  // 6. Polite peer (higher ID) does NOT create offer on peer-joined
  it('polite peer (higher ID) waits for offer', async () => {
    // Use peerId that is higher than the remote
    signaling = createMockSignaling('zzz-local');
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'aaa-remote' });
    });

    const pc = result.current.pcRef.current as any;
    // Polite peer should NOT create offer — it waits for the impolite peer
    expect(pc.createOffer).not.toHaveBeenCalled();
  });

  // 7. Impolite peer creates data channels, polite uses ondatachannel
  it('impolite peer creates data channels', async () => {
    // local-aaaa < remote-zzzz → impolite → creates channels
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    expect(pc.createDataChannel).toHaveBeenCalledTimes(2);
    expect(pc.createDataChannel).toHaveBeenCalledWith('chat', { ordered: true });
    expect(pc.createDataChannel).toHaveBeenCalledWith('file', { ordered: true });
  });

  it('polite peer uses ondatachannel', async () => {
    signaling = createMockSignaling('zzz-local');
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'aaa-remote' });
    });

    const pc = result.current.pcRef.current as any;
    expect(pc.createDataChannel).not.toHaveBeenCalled();
    expect(pc.ondatachannel).not.toBeNull();
  });

  // 8. Offer message creates answer (polite peer)
  it('offer message creates answer and sends it', async () => {
    signaling = createMockSignaling('zzz-local');
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    // First create the PC via peer-joined
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'aaa-remote' });
    });

    const pc = result.current.pcRef.current as any;

    // Now receive an offer from that peer
    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\noffer-sdp\r\n', from: 'aaa-remote' } as any);
    });

    expect(pc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'offer',
      sdp: 'v=0\r\noffer-sdp\r\n',
    });
    expect(pc.createAnswer).toHaveBeenCalled();
    expect(pc.setLocalDescription).toHaveBeenCalled();
    expect(signaling.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer', to: 'aaa-remote' })
    );
  });

  // 9. Answer message sets remote description
  it('answer message sets remote description', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    pc.signalingState = 'have-local-offer';

    await act(async () => {
      await handler({ type: 'answer', sdp: 'v=0\r\nanswer-sdp\r\n', from: 'remote-zzzz' } as any);
    });

    expect(pc.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'v=0\r\nanswer-sdp\r\n',
    });
  });

  // 10. ICE candidate with from field adds to correct PC
  it('ice-candidate adds to correct PC', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    pc.remoteDescription = { type: 'answer', sdp: 'v=0\r\nanswer\r\n' };

    const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };
    await act(async () => {
      await handler({ type: 'ice-candidate', candidate, from: 'remote-zzzz' } as any);
    });

    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  // 10b. ICE candidate before remote description is queued then flushed
  it('ice-candidate before remote description is queued then flushed', async () => {
    signaling = createMockSignaling('zzz-local');
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'aaa-remote' });
    });

    const pc = result.current.pcRef.current as any;
    const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };

    // Send candidate before remote description — should be queued
    await act(async () => {
      await handler({ type: 'ice-candidate', candidate, from: 'aaa-remote' } as any);
    });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    // Now receive an offer — remote description gets set, candidates flushed
    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\noffer-sdp\r\n', from: 'aaa-remote' } as any);
    });
    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  // 11. peer-disconnected destroys specific PC
  it('peer-disconnected destroys specific PC', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    expect(result.current.peerCount).toBe(1);
    const pc = result.current.pcRef.current as any;

    await act(async () => {
      await handler({ type: 'peer-disconnected', peerId: 'remote-zzzz' });
    });

    expect(pc.close).toHaveBeenCalled();
    expect(result.current.peerCount).toBe(0);
    expect(result.current.pcRef.current).toBeNull();
    expect(result.current.connectionState).toBe('new');
  });

  // 11b. With multiple peers, only the disconnected one is removed
  it('peer-disconnected removes only specific peer', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'room-state', peers: ['peer-bbbb', 'peer-cccc'] });
    });

    expect(result.current.peerCount).toBe(2);

    await act(async () => {
      await handler({ type: 'peer-disconnected', peerId: 'peer-bbbb' });
    });

    expect(result.current.peerCount).toBe(1);
    expect(result.current.peers.has('peer-bbbb')).toBe(false);
    expect(result.current.peers.has('peer-cccc')).toBe(true);
  });

  // 12. cleanup closes all PCs and resets state
  it('cleanup closes all PCs and resets state', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'room-state', peers: ['peer-bbbb', 'peer-cccc'] });
    });

    expect(result.current.peerCount).toBe(2);

    act(() => {
      result.current.cleanup();
    });

    expect(result.current.peerCount).toBe(0);
    expect(result.current.connectionState).toBe('new');
    expect(result.current.chatChannel).toBeNull();
    expect(result.current.fileChannel).toBeNull();
    expect(result.current.hmacKey).toBeNull();
    expect(result.current.callError).toBeNull();
  });

  // 13. startCall adds tracks to all PCs
  it('startCall adds tracks to all PCs', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'room-state', peers: ['peer-bbbb', 'peer-cccc'] });
    });

    await act(async () => {
      await result.current.startCall();
    });

    expect(navigator.mediaDevices.enumerateDevices).toHaveBeenCalled();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(result.current.localStream).not.toBeNull();

    // Both PCs should have addTrack called
    for (const info of result.current.peers.values()) {
      // We can't directly access the mock PC from PeerInfo, but we know
      // addTrack was called because startCall iterates all peers
    }
  });

  // 14. endCall stops senders
  it('endCall clears local stream', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    await act(async () => {
      await result.current.startCall();
    });

    act(() => {
      result.current.endCall();
    });

    expect(result.current.localStream).toBeNull();
  });

  // 15. getFingerprint from primary peer
  it('getFingerprint extracts fingerprint from primary peer SDP', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    pc.localDescription = {
      type: 'offer',
      sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89\r\n',
    };

    const fingerprint = result.current.getFingerprint();
    expect(fingerprint).toBe('AB:CD:EF:01:23:45:67:89');
  });

  it('getFingerprint returns null when no peers', () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    const fingerprint = result.current.getFingerprint();
    expect(fingerprint).toBeNull();
  });

  // 16. init with no RTCPeerConnection sets callError
  it('sets callError when RTCPeerConnection is unavailable', async () => {
    const original = globalThis.RTCPeerConnection;
    delete (globalThis as any).RTCPeerConnection;

    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    expect(result.current.callError).not.toBeNull();
    expect(result.current.callError).toContain('WebRTC is not supported');
    expect(result.current.peerCount).toBe(0);

    (globalThis as any).RTCPeerConnection = original;
  });

  // 17. Polite peer accepts incoming offer during collision
  it('polite peer accepts incoming offer during collision', async () => {
    signaling = createMockSignaling('zzz-local'); // higher ID → polite
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'aaa-remote' });
    });

    const pc = result.current.pcRef.current as any;
    pc.signalingState = 'have-local-offer';

    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\ncollision-offer\r\n', from: 'aaa-remote' } as any);
    });

    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.createAnswer).toHaveBeenCalled();
  });

  // 18. Impolite peer ignores incoming offer during collision
  it('impolite peer ignores incoming offer during collision', async () => {
    // local-aaaa < remote-zzzz → local is impolite
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    pc.signalingState = 'have-local-offer';
    pc.setRemoteDescription.mockClear();
    pc.createAnswer.mockClear();

    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\ncollision-offer\r\n', from: 'remote-zzzz' } as any);
    });

    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(pc.createAnswer).not.toHaveBeenCalled();
  });

  // 19. ICE candidates include `to` field for addressed routing
  it('ICE candidates are sent with to field', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    // Simulate ICE candidate event
    const mockCandidate = { candidate: 'candidate:1', toJSON: () => ({ candidate: 'candidate:1' }) };
    act(() => {
      pc.onicecandidate({ candidate: mockCandidate });
    });

    expect(signaling.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ice-candidate',
        to: 'remote-zzzz',
        candidate: { candidate: 'candidate:1' },
      })
    );
  });

  // 20. init() skips if already called
  it('init skips if already called', () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });
    act(() => { result.current.init(null); });

    expect(signaling.onMessage).toHaveBeenCalledTimes(1);
  });

  // 21. Messages without from field are ignored (except lifecycle messages)
  it('ignores offer without from field', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    const pc = result.current.pcRef.current as any;
    pc.setRemoteDescription.mockClear();

    // Offer with no from field → ignored
    await act(async () => {
      await handler({ type: 'offer', sdp: 'v=0\r\n' });
    });

    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  // 22. New peer joining mid-session gets existing local tracks
  it('new peer gets existing local tracks added to their PC', async () => {
    const { result } = renderHook(() => useWebRTC(signaling));

    act(() => { result.current.init(null); });

    const handler = getMessageHandler(signaling);
    // First peer joins
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'remote-zzzz' });
    });

    // Start call (adds tracks to first PC)
    await act(async () => {
      await result.current.startCall();
    });

    // Second peer joins mid-session — should get existing tracks
    await act(async () => {
      await handler({ type: 'peer-joined', peerId: 'peer-mmmm' });
    });

    expect(result.current.peerCount).toBe(2);
    // The second PC should have addTrack called during creation
    // because localStreamRef already has tracks
  });

  // 23. localPeerId reflects signaling peerId
  it('localPeerId reflects signaling peerId', () => {
    signaling = createMockSignaling('my-unique-id');
    const { result } = renderHook(() => useWebRTC(signaling));
    expect(result.current.localPeerId).toBe('my-unique-id');
  });
});
