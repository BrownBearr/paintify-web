import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// This repository intentionally has no package.json/module mode; load the
// browser ES module as a data URL so Node tests exercise the shipped source.
const source = await readFile(new URL('../video-export.js', import.meta.url), 'utf8');
const {
  VIDEO_EXPORT_CODECS,
  chooseRecordingMimeType,
  negotiateVideoEncoderConfig,
  seekVideo,
  waitForEncoderQueue,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('encoder negotiation prefers H.264 baseline then falls back through codecs', async () => {
  const seen = [];
  const VideoEncoder = { isConfigSupported: async config => {
    seen.push(config.codec);
    return { supported: config.codec === 'avc1.42E01E', config };
  } };
  const picked = await negotiateVideoEncoderConfig({ VideoEncoder, width: 640, height: 480, bitrate: 900000, framerate: 30 });
  assert.equal(picked.codec, 'avc1.42E01E');
  assert.equal(picked.mux, 'avc');
  assert.deepEqual(seen, ['avc1.42E01E']);
  assert.equal(VIDEO_EXPORT_CODECS[1].codec, 'avc1.4D4028');

  const fallback = await negotiateVideoEncoderConfig({
    VideoEncoder: { isConfigSupported: async c => { if (c.codec.startsWith('avc1')) throw new Error('probe failed'); return { supported: c.codec.startsWith('vp09'), config: c }; } },
    width: 2, height: 2, bitrate: 100, framerate: 30,
  });
  assert.equal(fallback.codec, 'vp09.00.40.08');
});

test('encoder negotiation returns null when API/configs are unavailable', async () => {
  assert.equal(await negotiateVideoEncoderConfig({ VideoEncoder: null }), null);
  assert.equal(await negotiateVideoEncoderConfig({
    VideoEncoder: { isConfigSupported: async () => ({ supported: false }) }, width: 2, height: 2, bitrate: 10, framerate: 30,
  }), null);
});

class FakeVideo extends EventTarget {
  constructor() { super(); this.seeking = true; this.currentTime = 0; this.error = null; }
  set currentTime(value) {
    this._currentTime = value;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  get currentTime() { return this._currentTime ?? 0; }
}

test('seek resolves when the browser emits seeked and skips an already-current time', async () => {
  await seekVideo(new FakeVideo(), 1.5, undefined, { timeoutMs: 100 });
  const video = new FakeVideo();
  video.seeking = false;
  video._currentTime = 4;
  await seekVideo(video, 4);
});

test('seek rejects on abort, media error, timeout, and invalid input', async () => {
  const ac = new AbortController();
  const pending = seekVideo({ seeking: true, currentTime: 0, addEventListener() {}, removeEventListener() {}, set currentTime(_) {} }, 1, ac.signal, { timeoutMs: 100 });
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  const errorVideo = { seeking: true, currentTime: 0, error: new Error('decode error'), addEventListener(type, cb) { if (type === 'error') queueMicrotask(cb); }, removeEventListener() {}, set currentTime(_) {} };
  await assert.rejects(seekVideo(errorVideo, 1, undefined, { timeoutMs: 100 }), /decode error/);

  const stalled = { seeking: true, currentTime: 0, addEventListener() {}, removeEventListener() {}, set currentTime(_) {} };
  await assert.rejects(seekVideo(stalled, 1, undefined, { timeoutMs: 10 }), { name: 'TimeoutError' });
  await assert.rejects(seekVideo(stalled, -1), RangeError);
});

test('encoder queue wait observes drain, callback failure, abort, closure, and timeout', async () => {
  let queue = 8;
  const draining = { state: 'configured', get encodeQueueSize() { return queue; } };
  setTimeout(() => { queue = 2; }, 10);
  await waitForEncoderQueue(draining, { maxQueueSize: 2, timeoutMs: 100, pollMs: 1 });

  const failure = new Error('codec failed');
  await assert.rejects(waitForEncoderQueue(draining, { getError: () => failure }), e => e === failure);
  const ac = new AbortController();
  const pending = waitForEncoderQueue({ state: 'configured', encodeQueueSize: 100 }, { signal: ac.signal, timeoutMs: 100 });
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(waitForEncoderQueue({ state: 'closed', encodeQueueSize: 0 }), { name: 'InvalidStateError' });
  await assert.rejects(waitForEncoderQueue({ state: 'configured', encodeQueueSize: 100 }, { timeoutMs: 10 }), { name: 'TimeoutError' });
});

test('camera MIME selection returns the negotiated type and matching extension', () => {
  const mp4 = chooseRecordingMimeType({ isTypeSupported: t => t === 'video/mp4' });
  assert.deepEqual(mp4, { mimeType: 'video/mp4', extension: 'mp4' });
  const webm = chooseRecordingMimeType({ isTypeSupported: t => t === 'video/webm' });
  assert.deepEqual(webm, { mimeType: 'video/webm', extension: 'webm' });
  assert.equal(chooseRecordingMimeType(null), null);
  assert.equal(chooseRecordingMimeType({ isTypeSupported: () => false }), null);
});
