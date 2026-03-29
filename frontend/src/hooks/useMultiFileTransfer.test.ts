import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useMultiFileTransfer from './useMultiFileTransfer';
import type { PeerInfo } from './useWebRTC';

// Mock channelAuth
vi.mock('../utils/channelAuth', () => ({
  signMessage: vi.fn((_key: any, raw: string) => raw),
  verifyMessage: vi.fn((_key: any, data: string) => data),
  signChunk: vi.fn((_key: any, chunk: ArrayBuffer) => chunk),
  verifyChunk: vi.fn((_key: any, chunk: ArrayBuffer) => chunk),
}));

// Mock compression
vi.mock('../utils/compression', () => ({
  compressFile: vi.fn(async (file: File) => ({
    compressed: new Blob(['compressed-data']),
    checksum: 'mock-checksum',
    originalSize: file.size,
  })),
  decompressBlob: vi.fn(async (blob: Blob) => blob),
}));

// Mock sounds
vi.mock('../utils/sounds', () => ({
  playFileComplete: vi.fn(),
}));

function createMockChannel(): RTCDataChannel {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  return {
    readyState: 'open',
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onbufferedamountlow: null,
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
    chatChannel: null,
    fileChannel: createMockChannel(),
    remoteStream: new MediaStream(),
    remoteScreenStream: new MediaStream(),
    hmacKey: null,
    ...overrides,
  };
}

describe('useMultiFileTransfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const peers = new Map<string, PeerInfo>();
    const { result } = renderHook(() => useMultiFileTransfer(peers));

    expect(result.current.incoming).toEqual([]);
    expect(result.current.outgoing).toBeNull();
    expect(result.current.sentFiles).toEqual([]);
  });

  it('receives file metadata from a peer', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiFileTransfer(peers));

    const ch = peer1.fileChannel as any;
    const meta = JSON.stringify({
      type: 'file-meta',
      id: 'file-1',
      name: 'test.txt',
      size: 1024,
      mimeType: 'text/plain',
      compressedSize: 512,
      checksum: 'abc123',
    });

    await act(async () => {
      ch._emit('message', { data: meta });
    });

    expect(result.current.incoming).toHaveLength(1);
    expect(result.current.incoming[0].id).toBe('file-1');
    expect(result.current.incoming[0].name).toBe('test.txt');
    expect(result.current.incoming[0].status).toBe('receiving');
  });

  it('receives files from multiple peers independently', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiFileTransfer(peers));

    const ch1 = peer1.fileChannel as any;
    const ch2 = peer2.fileChannel as any;

    await act(async () => {
      ch1._emit('message', {
        data: JSON.stringify({
          type: 'file-meta', id: 'file-a', name: 'from-a.txt',
          size: 100, mimeType: 'text/plain', compressedSize: 50, checksum: 'a',
        }),
      });
    });

    await act(async () => {
      ch2._emit('message', {
        data: JSON.stringify({
          type: 'file-meta', id: 'file-b', name: 'from-b.txt',
          size: 200, mimeType: 'text/plain', compressedSize: 100, checksum: 'b',
        }),
      });
    });

    expect(result.current.incoming).toHaveLength(2);
    expect(result.current.incoming[0].name).toBe('from-a.txt');
    expect(result.current.incoming[1].name).toBe('from-b.txt');
  });

  it('sendFile sends metadata to all peers', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiFileTransfer(peers));

    const file = new File(['hello world'], 'test.txt', { type: 'text/plain' });

    await act(async () => {
      await result.current.sendFile(file);
    });

    // Both channels should receive the file-meta message
    const ch1 = peer1.fileChannel as any;
    const ch2 = peer2.fileChannel as any;
    expect(ch1.send).toHaveBeenCalled();
    expect(ch2.send).toHaveBeenCalled();

    // Check that metadata was sent
    const firstCallData = ch1.send.mock.calls[0][0];
    const meta = JSON.parse(firstCallData);
    expect(meta.type).toBe('file-meta');
    expect(meta.name).toBe('test.txt');
  });

  it('cancelTransfer notifies all peers', () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peer2 = createPeerInfo({ peerId: 'peer-bbbb' });
    const peers = new Map([['peer-aaaa', peer1], ['peer-bbbb', peer2]]);

    const { result } = renderHook(() => useMultiFileTransfer(peers));

    act(() => {
      result.current.cancelTransfer('file-1');
    });

    const ch1 = peer1.fileChannel as any;
    const ch2 = peer2.fileChannel as any;
    expect(ch1.send).toHaveBeenCalled();
    expect(ch2.send).toHaveBeenCalled();

    const sent = JSON.parse(ch1.send.mock.calls[0][0]);
    expect(sent.type).toBe('file-cancel');
    expect(sent.id).toBe('file-1');
  });

  it('rejects oversized files', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiFileTransfer(peers));

    // Create a file that exceeds MAX_FILE_SIZE
    const bigFile = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
    Object.defineProperty(bigFile, 'size', { value: 600 * 1024 * 1024 });

    await act(async () => {
      await result.current.sendFile(bigFile);
    });

    expect(result.current.outgoing?.status).toBe('failed');
  });

  it('does not send when no peers have open file channels', async () => {
    const peers = new Map<string, PeerInfo>();
    const { result } = renderHook(() => useMultiFileTransfer(peers));

    const file = new File(['hello'], 'test.txt');
    await act(async () => {
      await result.current.sendFile(file);
    });

    // Should not crash, outgoing should be null
    expect(result.current.outgoing).toBeNull();
  });

  it('handles file-cancel from peer', async () => {
    const peer1 = createPeerInfo({ peerId: 'peer-aaaa' });
    const peers = new Map([['peer-aaaa', peer1]]);

    const { result } = renderHook(() => useMultiFileTransfer(peers));

    const ch = peer1.fileChannel as any;

    // First receive metadata
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({
          type: 'file-meta', id: 'file-1', name: 'test.txt',
          size: 100, mimeType: 'text/plain', compressedSize: 50, checksum: 'a',
        }),
      });
    });

    expect(result.current.incoming).toHaveLength(1);
    expect(result.current.incoming[0].status).toBe('receiving');

    // Then peer cancels
    await act(async () => {
      ch._emit('message', {
        data: JSON.stringify({ type: 'file-cancel', id: 'file-1' }),
      });
    });

    expect(result.current.incoming[0].status).toBe('failed');
    expect(result.current.incoming[0].error).toBe('Cancelled by peer');
  });
});
