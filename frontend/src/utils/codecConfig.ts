// Codec preference configuration for WebRTC
// Camera: H264 (best HW encode) > VP8 > VP9; Screen: VP9 (sharp text) > H264 > VP8
// Opus for audio with per-stream optimization (voice vs. music)

/**
 * Set video codec preferences on video transceivers.
 * - "camera" (default): H264 first (near-universal HW encode), then VP8, VP9
 * - "screen": VP9 first (better compression for sharp text/code), then H264, VP8
 * AV1 is always deprioritized — most machines lack HW encode.
 */
export function preferVideoCodecs(
  pc: RTCPeerConnection,
  contentType: "camera" | "screen" = "camera"
): void {
  if (!RTCRtpTransceiver.prototype.setCodecPreferences) return; // Safari fallback

  const transceivers = pc.getTransceivers();
  for (const t of transceivers) {
    if (t.sender?.track?.kind === "video" || t.receiver?.track?.kind === "video") {
      try {
        const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs;
        if (!codecs) continue;

        const sorted = [...codecs].sort((a, b) => {
          const rank = (c: { mimeType: string }): number => {
            const mime = c.mimeType.toLowerCase();
            if (contentType === "camera") {
              // Camera: H264 (best HW encode support) > VP8 > VP9
              if (mime.includes("h264")) return 0;
              if (mime.includes("vp8")) return 1;
              if (mime.includes("vp9")) return 2;
            } else {
              // Screen: VP9 (sharp text at lower bitrate) > H264 > VP8
              if (mime.includes("vp9")) return 0;
              if (mime.includes("h264")) return 1;
              if (mime.includes("vp8")) return 2;
            }
            if (mime.includes("av1") || mime.includes("av01")) return 3;
            return 4;
          };
          return rank(a) - rank(b);
        });

        t.setCodecPreferences(sorted);
      } catch {
        // setCodecPreferences not supported or codec list invalid
      }
    }
  }
}

/**
 * Set audio codec preferences — prefer Opus with voice optimization.
 * Configures: DTX (discontinuous transmission for silence), FEC, CBR off.
 */
export function preferAudioCodecs(pc: RTCPeerConnection): void {
  if (!RTCRtpTransceiver.prototype.setCodecPreferences) return;

  const transceivers = pc.getTransceivers();
  for (const t of transceivers) {
    if (t.sender?.track?.kind === "audio" || t.receiver?.track?.kind === "audio") {
      try {
        const codecs = RTCRtpReceiver.getCapabilities("audio")?.codecs;
        if (!codecs) continue;

        // Prefer Opus, then rest
        const sorted = [...codecs].sort((a, b) => {
          const isOpusA = a.mimeType.toLowerCase().includes("opus") ? 0 : 1;
          const isOpusB = b.mimeType.toLowerCase().includes("opus") ? 0 : 1;
          return isOpusA - isOpusB;
        });

        t.setCodecPreferences(sorted);
      } catch {
        // Fallback — browser will use default preference
      }
    }
  }
}

// Voice-optimized Opus params (mic audio)
const VOICE_OPUS_PARAMS: Record<string, number> = {
  usedtx: 1,              // Discontinuous transmission — saves bandwidth during silence
  useinbandfec: 1,        // Forward error correction — resilience to packet loss
  maxaveragebitrate: 48000, // 48kbps — good quality for wideband voice
};

// Music/system audio Opus params (screen share audio)
const MUSIC_OPUS_PARAMS: Record<string, number> = {
  usedtx: 0,              // No DTX — continuous audio, no silence detection
  useinbandfec: 1,        // FEC still useful for loss resilience
  maxaveragebitrate: 128000, // 128kbps — sufficient for stereo music
  stereo: 1,              // Enable stereo decoding
  "sprop-stereo": 1,      // Signal that we send stereo
} as Record<string, number>;

/**
 * Apply Opus params to a single audio m-section's fmtp line.
 */
function applyOpusParams(section: string, opusParams: Record<string, number>): string {
  const opusMatches = [...section.matchAll(/a=rtpmap:(\d+) opus\/48000/g)];
  if (opusMatches.length === 0) return section;

  let result = section;
  for (const match of opusMatches) {
    const pt = match[1];
    const fmtpRegex = new RegExp(`a=fmtp:${pt} (.+)`);
    const fmtpMatch = result.match(fmtpRegex);

    if (fmtpMatch) {
      const existing: Record<string, string> = {};
      fmtpMatch[1].split(";").forEach((p) => {
        const [k, v] = p.trim().split("=");
        if (k) existing[k] = v;
      });
      const merged = { ...existing, ...opusParams };
      const paramStr = Object.entries(merged)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      result = result.replace(fmtpRegex, `a=fmtp:${pt} ${paramStr}`);
    } else {
      const paramStr = Object.entries(opusParams)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      result = result.replace(
        `a=rtpmap:${pt} opus/48000`,
        `a=rtpmap:${pt} opus/48000\r\na=fmtp:${pt} ${paramStr}`
      );
    }
  }
  return result;
}

/**
 * Optimize Opus settings in SDP with per-stream differentiation.
 * - Voice (mic): DTX on, 48kbps, mono
 * - Music (screen share audio): DTX off, 128kbps, stereo
 *
 * When screenAudioActive is true, the first audio m-section gets voice params
 * and subsequent audio m-sections get music params.
 */
export function optimizeOpusInSDP(sdp: string, screenAudioActive = false): string {
  if (!sdp) return sdp;

  if (!screenAudioActive) {
    // Simple path: apply voice params to everything
    return applyOpusParams(sdp, VOICE_OPUS_PARAMS);
  }

  // Split SDP into m-line sections for per-stream params
  const lines = sdp.split("\r\n");
  const sections: { start: number; isAudio: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("m=")) {
      sections.push({ start: i, isAudio: lines[i].startsWith("m=audio") });
    }
  }

  if (sections.length === 0) return applyOpusParams(sdp, VOICE_OPUS_PARAMS);

  // Process each m-section independently
  let audioIndex = 0;
  const resultParts: string[] = [];
  for (let s = 0; s < sections.length; s++) {
    const start = sections[s].start;
    const end = s + 1 < sections.length ? sections[s + 1].start : lines.length;
    let sectionText = lines.slice(start, end).join("\r\n");

    if (sections[s].isAudio) {
      const params = audioIndex === 0 ? VOICE_OPUS_PARAMS : MUSIC_OPUS_PARAMS;
      sectionText = applyOpusParams(sectionText, params);
      audioIndex++;
    }
    resultParts.push(sectionText);
  }

  // Prepend the session-level lines (before first m=)
  const sessionLines = lines.slice(0, sections[0].start).join("\r\n");
  return sessionLines + "\r\n" + resultParts.join("\r\n");
}
