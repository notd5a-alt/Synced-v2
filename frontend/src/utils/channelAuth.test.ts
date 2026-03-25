import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveHmacKey, signMessage, verifyMessage, signChunk, verifyChunk } from './channelAuth';

const MOCK_SDP_LOCAL = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC:DD:EE:FF\r\n';
const MOCK_SDP_REMOTE = 'v=0\r\na=fingerprint:sha-256 11:22:33:44:55:66\r\n';
const MOCK_SDP_NO_FP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('deriveHmacKey', () => {
  it('returns a key for valid SDPs with fingerprints', async () => {
    const key = await deriveHmacKey(MOCK_SDP_LOCAL, MOCK_SDP_REMOTE);
    expect(key).not.toBeNull();
    expect(crypto.subtle.importKey).toHaveBeenCalled();
    expect(crypto.subtle.deriveKey).toHaveBeenCalled();
  });

  it('returns null when local SDP has no fingerprint', async () => {
    const key = await deriveHmacKey(MOCK_SDP_NO_FP, MOCK_SDP_REMOTE);
    expect(key).toBeNull();
  });

  it('returns null when remote SDP has no fingerprint', async () => {
    const key = await deriveHmacKey(MOCK_SDP_LOCAL, MOCK_SDP_NO_FP);
    expect(key).toBeNull();
  });

  it('produces same key regardless of local/remote order', async () => {
    await deriveHmacKey(MOCK_SDP_LOCAL, MOCK_SDP_REMOTE);
    const call1Args = (crypto.subtle.importKey as ReturnType<typeof vi.fn>).mock.calls[0];

    vi.restoreAllMocks();
    await deriveHmacKey(MOCK_SDP_REMOTE, MOCK_SDP_LOCAL);
    const call2Args = (crypto.subtle.importKey as ReturnType<typeof vi.fn>).mock.calls[0];

    // The raw key material (ikm) should be the same since fingerprints are sorted
    const decoder = new TextDecoder();
    expect(decoder.decode(call1Args[1] as ArrayBuffer)).toBe(decoder.decode(call2Args[1] as ArrayBuffer));
  });
});

describe('signMessage + verifyMessage', () => {
  const mockKey = { type: 'secret' } as CryptoKey;

  it('round-trip: sign then verify returns original payload', async () => {
    const payload = JSON.stringify({ type: 'text', content: 'hello' });
    const envelope = await signMessage(mockKey, payload);
    expect(typeof envelope).toBe('string');

    // Parse the envelope to check structure
    const parsed = JSON.parse(envelope);
    expect(parsed.p).toBe(payload);
    expect(parsed.h).toBeTruthy();

    const verified = await verifyMessage(mockKey, envelope);
    expect(verified).toBe(payload);
  });

  it('returns null for invalid envelope', async () => {
    const result = await verifyMessage(mockKey, 'not-json');
    expect(result).toBeNull();
  });

  it('returns null when envelope lacks p or h fields', async () => {
    const result = await verifyMessage(mockKey, JSON.stringify({ foo: 'bar' }));
    expect(result).toBeNull();
  });

  it('returns null when HMAC verification fails', async () => {
    (crypto.subtle.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const envelope = await signMessage(mockKey, 'test');
    const result = await verifyMessage(mockKey, envelope);
    expect(result).toBeNull();
  });
});

describe('signChunk + verifyChunk', () => {
  const mockKey = { type: 'secret' } as CryptoKey;

  it('round-trip: signed chunk verifies successfully', async () => {
    const chunk = new ArrayBuffer(100);
    const signed = await signChunk(mockKey, chunk, 'file-123', 0);
    expect(signed.byteLength).toBe(32 + 100); // 32B HMAC + 100B chunk

    const verified = await verifyChunk(mockKey, signed, 'file-123', 0);
    expect(verified).not.toBeNull();
    expect(verified!.byteLength).toBe(100);
  });

  it('returns null for truncated data', async () => {
    const tooShort = new ArrayBuffer(16); // less than HMAC_LEN (32)
    const result = await verifyChunk(mockKey, tooShort, 'file-123', 0);
    expect(result).toBeNull();
  });

  it('returns null when verification fails', async () => {
    (crypto.subtle.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const chunk = new ArrayBuffer(50);
    const signed = await signChunk(mockKey, chunk, 'file-123', 0);
    const result = await verifyChunk(mockKey, signed, 'file-123', 0);
    expect(result).toBeNull();
  });
});
