import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import FileShare from './FileShare';
import type { IncomingFile, OutgoingFile } from '../types';

const defaultProps = {
  incoming: [] as IncomingFile[],
  outgoing: null as OutgoingFile | null,
  onSendFile: vi.fn(),
  onCancel: vi.fn(),
};

describe('FileShare', () => {
  it('renders drop zone', () => {
    render(<FileShare {...defaultProps} />);
    expect(screen.getByText(/Drop a file here/)).toBeInTheDocument();
  });

  it('shows outgoing file progress', () => {
    const outgoing: OutgoingFile = {
      id: 'f1', name: 'test.txt', size: 1000,
      compressedSize: 800, bytesSent: 400, status: 'sending',
    };
    render(<FileShare {...defaultProps} outgoing={outgoing} />);
    expect(screen.getByText(/test\.txt/)).toBeInTheDocument();
  });

  it('shows completed incoming file with download link', () => {
    const incoming: IncomingFile[] = [
      {
        id: 'f2', name: 'photo.jpg', size: 2048,
        compressedSize: 1500, progress: 1, blobUrl: 'blob:test-url', status: 'completed',
      },
    ];
    render(<FileShare {...defaultProps} incoming={incoming} />);
    expect(screen.getByText(/DOWNLOAD/)).toBeInTheDocument();
    expect(screen.getByText('photo.jpg')).toBeInTheDocument();
  });

  it('shows in-progress incoming file', () => {
    const incoming: IncomingFile[] = [
      {
        id: 'f3', name: 'data.zip', size: 10000,
        compressedSize: 8000, progress: 0.75, blobUrl: null, status: 'receiving',
      },
    ];
    render(<FileShare {...defaultProps} incoming={incoming} />);
    expect(screen.getByText('data.zip')).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });
});
