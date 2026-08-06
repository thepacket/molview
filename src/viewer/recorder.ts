/**
 * Recording a pane to video.
 *
 * Auto-rotate has existed for a while and there was no way to keep it. This
 * drives the camera frame by frame rather than recording the screen in real
 * time, which matters more than it sounds: a real-time capture of a 2.4M-atom
 * assembly records the stutter, and the turn comes out uneven. Here the
 * rotation is a function of frame number, the recorder is fed one frame per
 * step through `requestFrame`, and a slow structure produces a slow *export*
 * and a smooth *video*.
 *
 * The output is WebM, because that is what browsers encode natively. There is
 * no MP4 without shipping an encoder, and no GIF without shipping a quantiser;
 * both are large additions for a format conversion any tool can do.
 */

export interface RecordingRequest {
  /** Frames to emit. */
  frames: number;
  framesPerSecond: number;
  /** Full turns of the camera over the whole clip. */
  turns: number;
  /** Longest output edge in pixels; the pane's aspect is kept. */
  maxSize: number;
  /** Called with 0-1 so the caller can show progress. */
  onProgress?: (fraction: number) => void;
}

export interface RecordingSource {
  /** The canvas holding every pane. */
  canvas: HTMLCanvasElement;
  /** Pixel rectangle of the pane being recorded, inside that canvas. */
  rect: { x: number; y: number; width: number; height: number };
  /** Turns the camera by this fraction of a full revolution and redraws. */
  step: (turnFraction: number) => void;
}

export class RecordingError extends Error {}

/** The first codec the browser will actually encode with. */
function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  throw new RecordingError('This browser cannot record WebM video.');
}

export async function recordTurntable(
  source: RecordingSource,
  request: RecordingRequest,
): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') {
    throw new RecordingError('This browser has no MediaRecorder.');
  }

  const { rect } = source;
  const scale = Math.min(1, request.maxSize / Math.max(rect.width, rect.height));
  // Even dimensions: VP9 encodes chroma in 2x2 blocks and an odd size is
  // either rejected or silently rounded, which shifts every frame by half a
  // pixel and shows up as a shimmer.
  const width = Math.max(2, Math.round((rect.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((rect.height * scale) / 2) * 2);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new RecordingError('Could not open a 2D context to record into.');

  // A zero-rate stream emits nothing until asked, which is what decouples the
  // video's timeline from how long each frame took to draw.
  const stream = out.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;

  const recorder = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: 8_000_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    recorder.onerror = () => reject(new RecordingError('The recorder failed mid-clip.'));
  });

  recorder.start();
  try {
    const frameMs = 1000 / request.framesPerSecond;
    const started = performance.now();
    for (let i = 0; i < request.frames; i++) {
      source.step((request.turns * i) / request.frames);
      // One rAF so the pane's render for this step has been presented before
      // it is copied.
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      ctx.drawImage(
        source.canvas,
        rect.x, rect.y, rect.width, rect.height,
        0, 0, width, height,
      );
      track.requestFrame();
      request.onProgress?.((i + 1) / request.frames);
      // The recorder timestamps by wall clock, so frames have to be spaced in
      // real time as well as counted. Waiting until the next slot rather than
      // for a fixed interval keeps the clip the length that was asked for
      // instead of stretching it by however long each render took.
      const due = started + (i + 1) * frameMs;
      const wait = due - performance.now();
      if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait); });
    }
  } finally {
    recorder.stop();
    track.stop();
  }

  return finished;
}

interface CanvasCaptureMediaStreamTrack extends MediaStreamTrack {
  requestFrame(): void;
}
