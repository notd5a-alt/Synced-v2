interface UpdateBannerProps {
  version: string;
  body?: string;
  installing: boolean;
  progress: number;
  error: string | null;
  onInstall: () => void;
  onDismiss: () => void;
}

export default function UpdateBanner({
  version,
  body,
  installing,
  progress,
  error,
  onInstall,
  onDismiss,
}: UpdateBannerProps) {
  return (
    <div className="update-banner">
      <div className="update-banner-content">
        <span className="update-banner-icon">&#x2191;</span>
        <div className="update-banner-text">
          <span className="update-banner-title">
            Synced v{version} available
          </span>
          {body && <span className="update-banner-notes">{body}</span>}
          {error && <span className="update-banner-error">{error}</span>}
        </div>
        <div className="update-banner-actions">
          {installing ? (
            <span className="update-banner-progress">
              Installing... {progress}%
            </span>
          ) : (
            <>
              <button className="btn small primary" onClick={onInstall}>
                [ UPDATE ]
              </button>
              <button className="btn small" onClick={onDismiss}>
                [ LATER ]
              </button>
            </>
          )}
        </div>
      </div>
      {installing && (
        <div className="update-banner-bar">
          <div
            className="update-banner-bar-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}
