import type { AudioBufferLike, Chapter } from '../types';

/** Loudness analysis window: 200ms. */
export const LOUDNESS_WINDOW_SEC = 0.2;
/**
 * Digital silence is -Infinity dBFS. A finite floor is used when silence
 * participates in dynamic-range display so exported values stay JSON-safe.
 */
export const SILENCE_DBFS = -100;

export type LoudnessStatus = 'ok' | 'quiet' | 'loud' | 'silent';
export type AnomalyKind = 'quiet' | 'loud';

/** Per-window analysis result, computed once from the decoded PCM. */
export interface LoudnessWindows {
  /** combined (all-channel) peak linear amplitude per fixed window */
  peaks: Float32Array;
  /** actual grid window in seconds (round(windowSec*sampleRate)/sampleRate) */
  windowSec: number;
  duration: number;
}

export interface LoudnessRange {
  start: number;
  end: number;
  kind: AnomalyKind;
}

export interface ChapterLoudness {
  status: LoudnessStatus;
  /** overlap-weighted mean dBFS of non-silent windows; null when fully silent */
  meanDbfs: number | null;
  /** dBFS spread across overlapping windows (silence floors the minimum) */
  rangeDb: number;
  /** seconds of the chapter covered by windows below the quiet threshold */
  quietDuration: number;
  /** seconds of the chapter covered by windows above the loud threshold */
  loudDuration: number;
  /** total chapter duration actually covered by analysis windows */
  analyzedDuration: number;
  /** start (clipped into the chapter) of its first anomalous window */
  firstAnomalyStart: number | null;
  firstAnomalyKind: AnomalyKind | null;
}

/**
 * Per-window combined peak dBFS over ALL channels of an already-decoded
 * buffer. Combined level = max |sample| across every channel/sample in the
 * window (standard peak dBFS). Strided like the RMS/peaks analysers to keep
 * per-window work bounded on long files; runs once at import time.
 */
export function computeLoudnessWindows(
  buffer: AudioBufferLike,
  windowSec: number = LOUDNESS_WINDOW_SEC,
): LoudnessWindows {
  const { sampleRate, length } = buffer;
  const winSamples = Math.max(1, Math.round(windowSec * sampleRate));
  const count = Math.max(1, Math.ceil(length / winSamples));
  const peaks = new Float32Array(count);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  for (let i = 0; i < count; i++) {
    const start = i * winSamples;
    const end = Math.min(length, start + winSamples);
    // stride to keep per-window work bounded on very long files
    const step = Math.max(1, Math.floor((end - start) / 1024));
    let peak = 0;
    for (const data of channels) {
      for (let s = start; s < end; s += step) {
        const v = data[s] < 0 ? -data[s] : data[s];
        if (v > peak) peak = v;
      }
    }
    peaks[i] = peak;
  }
  return { peaks, windowSec: winSamples / sampleRate, duration: buffer.duration };
}

/** dBFS of one analysis window; digital silence maps to -Infinity. */
export function windowDbfs(w: LoudnessWindows, i: number): number {
  const p = w.peaks[i];
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

/**
 * Classify one window against thresholds. Silent windows always count as
 * quiet for any finite quiet threshold; loud takes precedence if the user
 * drags the thresholds past each other.
 */
function classifyWindow(db: number, quietDb: number, loudDb: number): AnomalyKind | null {
  if (db > loudDb) return 'loud';
  if (db < quietDb) return 'quiet';
  return null;
}

/**
 * Weighted loudness summary for one chapter. Every window contributes in
 * proportion to its ACTUAL overlap with the chapter, so windows straddling
 * chapter boundaries are split correctly instead of being wholly assigned
 * to either side. Never returns NaN: fully silent chapters get
 * status 'silent' with meanDbfs null; zero-length / sub-window chapters
 * still yield finite numbers as long as any overlap exists.
 */
export function classifyChapterLoudness(
  w: LoudnessWindows,
  chapter: Chapter,
  quietDb: number,
  loudDb: number,
): ChapterLoudness {
  const cStart = Math.max(0, Math.min(chapter.start, w.duration));
  const cEnd = Math.max(0, Math.min(chapter.end, w.duration));

  let weight = 0;
  let signalWeight = 0;
  let sumDbWeighted = 0;
  let maxDb = -Infinity;
  let minDb = Infinity;
  let quietDuration = 0;
  let loudDuration = 0;
  let firstAnomalyStart: number | null = null;
  let firstAnomalyKind: AnomalyKind | null = null;

  if (cEnd > cStart) {
    const i0 = Math.max(0, Math.floor(cStart / w.windowSec));
    const i1 = Math.min(w.peaks.length, Math.ceil(cEnd / w.windowSec));
    for (let i = i0; i < i1; i++) {
      const ws = i * w.windowSec;
      const we = Math.min(w.duration, (i + 1) * w.windowSec);
      const overlap = Math.min(we, cEnd) - Math.max(ws, cStart);
      if (!(overlap > 0)) continue; // no actual overlap (guards fp edges)
      weight += overlap;

      const db = windowDbfs(w, i);
      if (db === -Infinity) {
        // digital silence: excluded from the finite mean, but always flagged
        // quiet (its -Inf dBFS is below every finite quiet threshold)
        quietDuration += overlap;
        if (firstAnomalyStart === null) {
          firstAnomalyStart = Math.max(ws, cStart);
          firstAnomalyKind = 'quiet';
        }
        continue;
      }

      signalWeight += overlap;
      sumDbWeighted += db * overlap;
      if (db > maxDb) maxDb = db;
      if (db < minDb) minDb = db;

      const kind = classifyWindow(db, quietDb, loudDb);
      if (kind === 'quiet') {
        quietDuration += overlap;
        if (firstAnomalyStart === null) {
          firstAnomalyStart = Math.max(ws, cStart);
          firstAnomalyKind = 'quiet';
        }
      } else if (kind === 'loud') {
        loudDuration += overlap;
        if (firstAnomalyStart === null) {
          firstAnomalyStart = Math.max(ws, cStart);
          firstAnomalyKind = 'loud';
        }
      }
    }
  }

  const meanDbfs = signalWeight > 0 ? sumDbWeighted / signalWeight : null;
  let rangeDb = 0;
  if (signalWeight > 0) {
    // silence inside the chapter floors the dynamic-range minimum
    const hasSilence = weight > signalWeight;
    const lo = hasSilence ? Math.min(minDb, SILENCE_DBFS) : minDb;
    rangeDb = maxDb - lo;
  }

  let status: LoudnessStatus;
  if (meanDbfs === null) {
    status = 'silent';
  } else if (meanDbfs > loudDb) {
    status = 'loud';
  } else if (meanDbfs < quietDb) {
    status = 'quiet';
  } else {
    status = 'ok';
  }

  return {
    status,
    meanDbfs,
    rangeDb,
    quietDuration,
    loudDuration,
    analyzedDuration: weight,
    firstAnomalyStart,
    firstAnomalyKind,
  };
}

/** Classify every chapter; keyed by chapter id for O(1) UI lookup. */
export function analyzeChaptersLoudness(
  w: LoudnessWindows,
  chapters: Chapter[],
  quietDb: number,
  loudDb: number,
): Map<string, ChapterLoudness> {
  const result = new Map<string, ChapterLoudness>();
  for (const c of chapters) {
    result.set(c.id, classifyChapterLoudness(w, c, quietDb, loudDb));
  }
  return result;
}

/**
 * Merge consecutive windows of the same anomaly kind into continuous
 * ranges. Segment edges follow the window grid, clamped at EOF to the
 * buffer duration. Pure judgment: call again when thresholds change,
 * the PCM analysis is reused untouched.
 */
export function findLoudnessAnomalies(
  w: LoudnessWindows,
  quietDb: number,
  loudDb: number,
): LoudnessRange[] {
  const segments: LoudnessRange[] = [];
  let kind: AnomalyKind | null = null;
  let runStart = -1;
  for (let i = 0; i <= w.peaks.length; i++) {
    let k: AnomalyKind | null = null;
    if (i < w.peaks.length) {
      k = classifyWindow(windowDbfs(w, i), quietDb, loudDb);
    }
    if (k !== kind) {
      if (kind !== null) {
        // round to 1ns: avoids 3*0.2 = 0.6000000000000001 style edge noise
        const segStart = Math.round(runStart * w.windowSec * 1e9) / 1e9;
        const segEnd = Math.round(Math.min(i * w.windowSec, w.duration) * 1e9) / 1e9;
        // suppress zero-length tail runs (e.g. empty / degenerate buffers)
        if (segEnd > segStart) {
          segments.push({ start: segStart, end: segEnd, kind });
        }
      }
      kind = k;
      runStart = i;
    }
  }
  return segments;
}
