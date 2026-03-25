import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import FileShare from './FileShare';
import type { IncomingFile, OutgoingFile } from '../types';

const meta: Meta<typeof FileShare> = {
  title: 'Components/FileShare',
  component: FileShare,
  args: {
    incoming: [],
    outgoing: null,
    onSendFile: fn() as unknown as (file: File) => Promise<void>,
  },
};

export default meta;
type Story = StoryObj<typeof FileShare>;

export const Empty: Story = {};

export const OutgoingInProgress: Story = {
  args: {
    outgoing: {
      id: 'f1',
      name: 'project-backup.zip',
      size: 52428800, // 50 MB
      bytesSent: 15728640, // ~30%
    } as OutgoingFile,
  },
};

export const CompletedIncoming: Story = {
  args: {
    incoming: [
      { id: 'f1', name: 'screenshot.png', size: 204800, progress: 1, blobUrl: 'blob:fake-url-1' },
      { id: 'f2', name: 'notes.txt', size: 1024, progress: 1, blobUrl: 'blob:fake-url-2' },
    ] as IncomingFile[],
  },
};

export const IncomingInProgress: Story = {
  args: {
    incoming: [
      { id: 'f1', name: 'large-video.mp4', size: 104857600, progress: 0.42, blobUrl: null },
    ] as IncomingFile[],
  },
};

export const MixedState: Story = {
  args: {
    incoming: [
      { id: 'f1', name: 'photo.jpg', size: 2048000, progress: 1, blobUrl: 'blob:fake-url' },
      { id: 'f2', name: 'document.pdf', size: 5242880, progress: 0.65, blobUrl: null },
    ] as IncomingFile[],
    outgoing: {
      id: 'f3',
      name: 'archive.tar.gz',
      size: 10485760,
      bytesSent: 8388608, // 80%
    } as OutgoingFile,
  },
};
