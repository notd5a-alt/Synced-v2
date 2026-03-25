import { describe, it, expect } from 'vitest';
import {
  playMessageSent,
  playMessageReceived,
  playPeerConnected,
  playPeerDisconnected,
  playCallEnded,
  playFileComplete,
  playError,
} from './sounds';

describe('sound effects', () => {
  const soundFunctions = [
    { name: 'playMessageSent', fn: playMessageSent },
    { name: 'playMessageReceived', fn: playMessageReceived },
    { name: 'playPeerConnected', fn: playPeerConnected },
    { name: 'playPeerDisconnected', fn: playPeerDisconnected },
    { name: 'playCallEnded', fn: playCallEnded },
    { name: 'playFileComplete', fn: playFileComplete },
    { name: 'playError', fn: playError },
  ];

  for (const { name, fn } of soundFunctions) {
    it(`${name} does not throw`, () => {
      expect(() => fn()).not.toThrow();
    });
  }
});
