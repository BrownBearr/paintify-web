// Small browser-API helpers shared by video export and camera recording.
// Kept free of app state so capability and failure paths can be tested in Node.

export const VIDEO_EXPORT_CODECS = [
  { codec: 'avc1.42E01E', mux: 'avc' }, // H.264 Baseline, level 3.0
  { codec: 'avc1.4D4028', mux: 'avc' }, // H.264 Main, level 4.0
  { codec: 'avc1.640028', mux: 'avc' }, // H.264 High, level 4.0
  { codec: 'vp09.00.40.08', mux: 'vp9' },
  { codec: 'av01.0.08M.08', mux: 'av1' },
];

function namedError(name, message) {
  const e = typeof DOMException === 'function'
    ? new DOMException(message, name)
    : Object.assign(new Error(message), { name });
  return e;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? namedError('AbortError', 'The operation was aborted.');
}

/** Return the first supported H.264 config, then VP9/AV1, or null. */
export async function negotiateVideoEncoderConfig({
  VideoEncoder = globalThis.VideoEncoder,
  width,
  height,
  bitrate,
  framerate,
  codecs = VIDEO_EXPORT_CODECS,
} = {}) {
  if (!VideoEncoder || typeof VideoEncoder.isConfigSupported !== 'function') return null;
  for (const candidate of codecs) {
    const config = { codec: candidate.codec, width, height, bitrate, framerate };
    try {
      const result = await VideoEncoder.isConfigSupported(config);
      if (result?.supported) return { ...candidate, config: result.config ?? config };
    } catch {
      // Unsupported configurations and transient UA errors fall through to
      // the next codec. The caller still handles configure()/encode failures.
    }
  }
  return null;
}

/** Seek a media element and reject if it stalls, errors, or is aborted. */
export function seekVideo(video, time, signal, { timeoutMs = 15000 } = {}) {
  throwIfAborted(signal);
  if (!Number.isFinite(time) || time < 0) return Promise.reject(new RangeError('Seek time must be a non-negative finite number.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('Seek timeout must be positive.'));
  if (!video.seeking && Math.abs(video.currentTime - time) < 1e-6) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err) => {
      cleanup();
      if (err) reject(err); else resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(video.error ?? new Error('Video seek failed.'));
    const onAbort = () => finish(signal.reason ?? namedError('AbortError', 'Video seek was aborted.'));

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(namedError('TimeoutError', `Video seek timed out after ${timeoutMs} ms.`)), timeoutMs);
    try {
      video.currentTime = time;
    } catch (e) {
      finish(e);
    }
  });
}

/** Wait until encoder backpressure clears, observing errors, aborts and timeout. */
export function waitForEncoderQueue(encoder, {
  maxQueueSize = 4,
  timeoutMs = 30000,
  pollMs = 5,
  signal,
  getError = () => null,
} = {}) {
  throwIfAborted(signal);
  if (!Number.isFinite(maxQueueSize) || maxQueueSize < 0) return Promise.reject(new RangeError('Queue limit must be non-negative.'));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('Encoder timeout must be positive.'));
  if (!Number.isFinite(pollMs) || pollMs <= 0) return Promise.reject(new RangeError('Poll interval must be positive.'));

  return new Promise((resolve, reject) => {
    let poll;
    let timer;
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (err) => {
      cleanup();
      if (err) reject(err); else resolve();
    };
    const onAbort = () => finish(signal.reason ?? namedError('AbortError', 'Video encoding was aborted.'));
    const check = () => {
      try {
        const error = getError();
        if (error) return finish(error);
        if (encoder.state === 'closed') return finish(namedError('InvalidStateError', 'Video encoder closed before its queue drained.'));
        if (encoder.encodeQueueSize <= maxQueueSize) return finish();
      } catch (e) {
        return finish(e);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(namedError('TimeoutError', `Video encoder queue did not drain within ${timeoutMs} ms.`)), timeoutMs);
    poll = setInterval(check, pollMs);
    check();
  });
}

/** Return a supported camera-recording MIME type and matching file extension. */
export function chooseRecordingMimeType(MediaRecorder = globalThis.MediaRecorder, candidates = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
]) {
  if (!MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  for (const mimeType of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return { mimeType, extension: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' };
      }
    } catch {
      // Continue through the fallback list if the user agent rejects a probe.
    }
  }
  return null;
}
