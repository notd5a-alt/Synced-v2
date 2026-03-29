import type { Meta, StoryObj } from '@storybook/react-vite';
import VideoGrid from './VideoGrid';
import type { PeerInfo } from '../hooks/useWebRTC';

function fakePc(): RTCPeerConnection {
  return new RTCPeerConnection();
}

function fakeStream(hasVideo = false, hasAudio = false): MediaStream {
  const tracks: MediaStreamTrack[] = [];
  if (hasVideo) {
    tracks.push({
      kind: 'video', readyState: 'live', muted: false, enabled: true, id: `v-${Math.random()}`,
    } as unknown as MediaStreamTrack);
  }
  if (hasAudio) {
    tracks.push({
      kind: 'audio', readyState: 'live', muted: false, enabled: true, id: `a-${Math.random()}`,
    } as unknown as MediaStreamTrack);
  }
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    id: `stream-${Math.random()}`,
  } as unknown as MediaStream;
}

function makePeer(
  id: string,
  opts: { video?: boolean; audio?: boolean; screen?: boolean; state?: RTCPeerConnectionState } = {},
): [string, PeerInfo] {
  return [id, {
    peerId: id,
    pc: fakePc(),
    connectionState: opts.state ?? 'connected',
    chatChannel: null,
    fileChannel: null,
    remoteStream: fakeStream(opts.video, opts.audio),
    remoteScreenStream: fakeStream(opts.screen),
    hmacKey: null,
  }];
}

const meta: Meta<typeof VideoGrid> = {
  title: 'Components/VideoGrid',
  component: VideoGrid,
  args: {
    localStream: null,
    localSpeaking: false,
    localHasVideo: false,
    peers: new Map(),
    peerSpeaking: new Map(),
    streamRevision: 0,
  },
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof VideoGrid>;

export const Solo: Story = {
  name: '1 participant (you)',
};

export const TwoPeers: Story = {
  name: '2 participants',
  args: {
    peers: new Map([
      makePeer('peer-aaaa-1111', { audio: true }),
    ]),
  },
};

export const FourPeers: Story = {
  name: '4 participants (2×2)',
  args: {
    peers: new Map([
      makePeer('peer-aaaa-1111', { audio: true }),
      makePeer('peer-bbbb-2222', { audio: true }),
      makePeer('peer-cccc-3333', { audio: true }),
    ]),
    peerSpeaking: new Map([['peer-bbbb-2222', true]]),
    localSpeaking: true,
  },
};

export const SixPeers: Story = {
  name: '6 participants (3×2)',
  args: {
    peers: new Map(
      Array.from({ length: 5 }, (_, i) =>
        makePeer(`peer-${String.fromCharCode(65 + i).repeat(4)}-${i}`, { audio: true })
      )
    ),
  },
};

export const EightPeers: Story = {
  name: '8 participants (4×2)',
  args: {
    peers: new Map(
      Array.from({ length: 7 }, (_, i) =>
        makePeer(`peer-${String.fromCharCode(65 + i).repeat(4)}-${i}`, { audio: true })
      )
    ),
    peerSpeaking: new Map([
      [`peer-AAAA-0`, true],
      [`peer-DDDD-3`, true],
    ]),
  },
};

export const WithScreenShare: Story = {
  name: 'Screen share (expandable)',
  args: {
    peers: new Map([
      makePeer('peer-aaaa-1111', { audio: true, screen: true }),
      makePeer('peer-bbbb-2222', { audio: true }),
    ]),
  },
};

export const MixedStates: Story = {
  name: 'Mixed connection states',
  args: {
    peers: new Map([
      makePeer('peer-connected', { audio: true, state: 'connected' }),
      makePeer('peer-connecting', { state: 'connecting' }),
      makePeer('peer-disconnected', { state: 'disconnected' }),
      makePeer('peer-failed-xyz', { state: 'failed' }),
    ]),
  },
};
