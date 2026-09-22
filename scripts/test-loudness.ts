import {
  LOUDNESS_WINDOW_SEC,
  SILENCE_DBFS,
  analyzeChaptersLoudness,
  classifyChapterLoudness,
  computeLoudnessWindows,
  findLoudnessAnomalies,
  windowDbfs,
} from '../src/audio/loudness';
import { toJSON } from '../src/utils/export';
import type { AudioBufferLike, Chapter } from '../src/types';

const mk = (id: string, start: number, end: number): Chapter => ({ id, title: id, start, end });
let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log(`ok ${msg}`);
  } else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function near(actual: number, expected: number, msg: string, tol = 1e-4) {
  check(Math.abs(actual - expected) <= tol, `${msg} (expected ~${expected}, got ${actual})`);
}
function nearRanges(
  actual: { start: number; end: number; kind: string }[],
  expected: { start: number; end: number; kind: string }[],
  msg: string,
) {
  const ok =
    actual.length === expected.length &&
    actual.every(
      (r, i) =>
        r.kind === expected[i].kind &&
        Math.abs(r.start - expected[i].start) < 1e-9 &&
        Math.abs(r.end - expected[i].end) < 1e-9,
    );
  check(ok, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function allFinite(obj: unknown, msg: string) {
  let ok = true;
  JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'number' && (!Number.isFinite(v) || Number.isNaN(v))) ok = false;
    return v;
  });
  check(ok, msg);
}

function fakeBuffer(channelData: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    duration: channelData[0].length / sampleRate,
    length: channelData[0].length,
    sampleRate,
    numberOfChannels: channelData.length,
    getChannelData: (c) => channelData[c],
  };
}

// --- 200ms window grid ---
{
  // 1s @ 1000Hz -> 5 windows of 200 samples
  const w = computeLoudnessWindows(fakeBuffer([new Float32Array(1000)], 1000), LOUDNESS_WINDOW_SEC);
  eq(w.peaks.length, 5, 'loudness 200ms window count');
  eq(w.windowSec, 0.2, 'actual grid window seconds');
  near(w.duration, 1, 'loudness duration passed through');
}

// --- per-window peak dBFS ---
{
  const data = new Float32Array(1000);
  data.fill(0.5, 0, 200); // window 0
  data.fill(0.1, 400, 600); // window 2
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  near(windowDbfs(w, 0), 20 * Math.log10(0.5), 'peak dBFS window 0');
  near(windowDbfs(w, 2), 20 * Math.log10(0.1), 'peak dBFS window 2');
  eq(windowDbfs(w, 1), -Infinity, 'silent window is -Infinity dBFS');
}

// --- multi-channel combined peak ---
{
  const a = new Float32Array(200).fill(0.4);
  const b = new Float32Array(200).fill(0.8);
  const w = computeLoudnessWindows(fakeBuffer([a, b], 1000));
  near(windowDbfs(w, 0), 20 * Math.log10(0.8), 'combined peak is max across channels');
}

// --- weighted mean: boundary-splitting windows, no misattribution ---
{
  // windows: [-Inf(0-.2), 0.001(.2-1)] -> audible windows -60 dBFS ("quiet")
  const data = new Float32Array(1000);
  data.fill(0.001, 200);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  // chapter .3 - .7: overlaps are .1, .2, .1 across three equal windows
  const q = classifyChapterLoudness(w, mk('a', 0.3, 0.7), -40, -3);
  near(q.meanDbfs!, 20 * Math.log10(0.001), 'weighted mean with split boundary windows', 1e-6);
  near(q.analyzedDuration, 0.4, 'analyzed duration equals chapter length', 1e-9);
  eq(q.status, 'quiet', 'mean below quiet threshold -> quiet');
}

// --- fully silent chapter: no NaN, status silent, mean null ---
{
  const w = computeLoudnessWindows(fakeBuffer([new Float32Array(1000)], 1000));
  const q = classifyChapterLoudness(w, mk('a', 0, 1), -40, -3);
  eq(q.status, 'silent', 'all-silent chapter status');
  eq(q.meanDbfs, null, 'all-silent chapter mean is null (not NaN/-Infinity)');
  eq(q.rangeDb, 0, 'all-silent chapter range 0');
  near(q.quietDuration, 1, 'silence counts toward quiet duration');
  allFinite(q, 'silent chapter metrics contain no NaN/Infinity');
}

// --- very short chapter (below one window): still finite, no NaN ---
{
  const data = new Float32Array(1000).fill(0.25);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const q = classifyChapterLoudness(w, mk('a', 0.05, 0.09), -40, -3);
  near(q.analyzedDuration, 0.04, 'sub-window chapter analyzed by overlap', 1e-9);
  check(q.meanDbfs !== null && Number.isFinite(q.meanDbfs), 'sub-window mean finite');
  eq(q.status, 'ok', 'loud-enough sub-window chapter is ok');
}

// --- zero-length chapter: degenerate but safe ---
{
  const data = new Float32Array(1000).fill(0.25);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const q = classifyChapterLoudness(w, mk('a', 0.5, 0.5), -40, -3);
  eq(q.status, 'silent', 'zero-length chapter handled as silent, no throw');
  eq(q.meanDbfs, null, 'zero-length chapter mean null');
  eq(q.rangeDb, 0, 'zero-length chapter range 0');
  allFinite(q, 'zero-length metrics finite');
}

// --- dynamic range across audible windows; silence floors the minimum ---
{
  // all audible: window 0 = 0.5, window 2 = 0.01 (window 1/3/4 also 0.01)
  const data = new Float32Array(1000).fill(0.01);
  data.fill(0.5, 0, 200);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  // chapter 0-.6 covers windows 0,1,2 — all audible, no silence floor
  const q = classifyChapterLoudness(w, mk('a', 0, 0.6), -70, -3);
  near(q.rangeDb, 20 * Math.log10(0.5 / 0.01), 'range = max - min audible dBFS');
  // chapter 0-1 also all audible here; test silence floor separately:
  const withSilence = new Float32Array(1000);
  withSilence.fill(0.5, 0, 200); // window 0 loud, windows 1..4 silent
  const w2 = computeLoudnessWindows(fakeBuffer([withSilence], 1000));
  const q2 = classifyChapterLoudness(w2, mk('b', 0, 1), -70, -3);
  near(q2.rangeDb, 20 * Math.log10(0.5) - SILENCE_DBFS, 'range floored by silence window');
}

// --- status loud ---
{
  const data = new Float32Array(1000).fill(0.9);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const q = classifyChapterLoudness(w, mk('a', 0, 1), -40, -3);
  eq(q.status, 'loud', 'mean above loud threshold -> loud');
  near(q.loudDuration, 1, 'whole chapter counted loud');
}

// --- cross-chapter windows: one window straddling boundary attributed by overlap ---
{
  const data = new Float32Array(1000).fill(0.25); // all audible, all "quiet" vs -10
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const map = analyzeChaptersLoudness(
    w,
    [mk('a', 0, 0.3), mk('b', 0.3, 0.7), mk('c', 0.7, 1)],
    -10,
    0,
  );
  near(map.get('a')!.analyzedDuration, 0.3, 'chapter a overlap weight .3', 1e-9);
  near(map.get('b')!.analyzedDuration, 0.4, 'chapter b overlap weight .4', 1e-9);
  near(map.get('c')!.analyzedDuration, 0.3, 'chapter c overlap weight .3', 1e-9);
  const total =
    map.get('a')!.analyzedDuration +
    map.get('b')!.analyzedDuration +
    map.get('c')!.analyzedDuration;
  near(total, 1, 'overlap weights partition the timeline exactly', 1e-9);
  allFinite([...map.values()], 'all chapter metrics finite');
}

// --- anomaly segmentation: consecutive windows merged, kinds kept separate ---
{
  // windows 0..4: quiet(0), loud(1), loud(2), quiet(3), quiet(4)
  const data = new Float32Array(1000);
  data.fill(0.001, 0, 200);
  data.fill(0.95, 200, 600);
  data.fill(0.001, 600, 1000);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const segs = findLoudnessAnomalies(w, -40, -3);
  nearRanges(
    segs,
    [
      { start: 0, end: 0.2, kind: 'quiet' },
      { start: 0.2, end: 0.6, kind: 'loud' },
      { start: 0.6, end: 1, kind: 'quiet' },
    ],
    'anomalies merged by consecutive same kind',
  );
}

// --- anomalies run to EOF and clamp to duration (partial last window) ---
{
  const data = new Float32Array(500).fill(0.9); // 0.5s -> 3 windows, last 100 samples
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const segs = findLoudnessAnomalies(w, -40, -3);
  nearRanges(segs, [{ start: 0, end: 0.5, kind: 'loud' }], 'last segment clamped to buffer duration');
}

// --- no anomalies when within thresholds ---
{
  const data = new Float32Array(1000).fill(0.1); // -20 dBFS
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  eq(findLoudnessAnomalies(w, -40, -3), [], 'within-range audio yields no anomalies');
}

// --- threshold change only re-classifies; same windows reused ---
{
  const data = new Float32Array(1000).fill(0.01); // -40 dBFS
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  // -30 dB is above -40 dBFS: flagged quiet; -50 dB is below: not flagged
  nearRanges(
    findLoudnessAnomalies(w, -30, -3),
    [{ start: 0, end: 1, kind: 'quiet' }],
    'strict quiet threshold flags all windows (merged)',
  );
  eq(findLoudnessAnomalies(w, -50, -3), [], 'loose quiet threshold clears flags');
  eq(classifyChapterLoudness(w, mk('a', 0, 1), -30, -3).status, 'quiet', 'quiet under strict threshold');
  eq(classifyChapterLoudness(w, mk('a', 0, 1), -50, -3).status, 'ok', 'ok after threshold relax');
}

// --- first anomaly localization clipped into chapter ---
{
  const data = new Float32Array(1000).fill(0.25);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  // chapter starts mid-window 1 (.2-.4); anomaly onset for that chapter is .3
  const q = classifyChapterLoudness(w, mk('a', 0.3, 1), -10, 0);
  near(q.firstAnomalyStart!, 0.3, 'first anomaly start clipped into chapter', 1e-9);
  eq(q.firstAnomalyKind, 'quiet', 'first anomaly kind quiet');
}

// --- multichannel stereo buffer through full pipeline ---
{
  const l = new Float32Array(1000).fill(0.0005);
  const r = new Float32Array(1000).fill(0.9); // ~-0.9 dBFS, above -3
  const w = computeLoudnessWindows(fakeBuffer([l, r], 1000));
  const segs = findLoudnessAnomalies(w, -40, -3);
  nearRanges(segs, [{ start: 0, end: 1, kind: 'loud' }], 'stereo: right-channel loudness detected');
}

// --- JSON export carries per-chapter QC metrics, silent-safe ---
{
  const data = new Float32Array(1000);
  data.fill(0.5, 0, 400);
  const w = computeLoudnessWindows(fakeBuffer([data], 1000));
  const chapters = [mk('ch1', 0, 1)];
  const map = analyzeChaptersLoudness(w, chapters, -40, -3);
  const quality = new Map(
    [...map].map(([id, q]) => [
      id,
      {
        loudnessStatus: q.status,
        meanDbfs: q.meanDbfs,
        dynamicRangeDb: q.rangeDb,
        quietDuration: q.quietDuration,
        loudDuration: q.loudDuration,
      },
    ]),
  );
  const json = toJSON(chapters, quality, {
    windowSec: LOUDNESS_WINDOW_SEC,
    quietThresholdDbfs: -40,
    loudThresholdDbfs: -3,
  });
  const parsed = JSON.parse(json);
  check(Array.isArray(parsed.chapters) && parsed.chapters.length === 1, 'json has chapters');
  const q0 = parsed.chapters[0].quality;
  check(q0 && typeof q0.meanDbfs === 'number' && Number.isFinite(q0.meanDbfs), 'json meanDbfs finite number');
  eq(parsed.loudness.windowSec, 0.2, 'json includes loudness config window');
  eq(parsed.loudness.quietThresholdDbfs, -40, 'json includes quiet threshold');
  check(Number.isFinite(q0.dynamicRangeDb), 'json dynamic range finite');

  // fully silent chapter -> meanDbfs null, JSON stays valid
  const wSilent = computeLoudnessWindows(fakeBuffer([new Float32Array(400)], 1000));
  const map2 = analyzeChaptersLoudness(wSilent, [mk('s', 0, 0.4)], -40, -3);
  const q2 = new Map(
    [...map2].map(([id, q]) => [
      id,
      {
        loudnessStatus: q.status,
        meanDbfs: q.meanDbfs,
        dynamicRangeDb: q.rangeDb,
        quietDuration: q.quietDuration,
        loudDuration: q.loudDuration,
      },
    ]),
  );
  const parsed2 = JSON.parse(toJSON([mk('s', 0, 0.4)], q2));
  eq(parsed2.chapters[0].quality.meanDbfs, null, 'json silent mean is null, not NaN');
  eq(parsed2.chapters[0].quality.loudnessStatus, 'silent', 'json silent status');
}

// --- empty file guard: zero-length buffer ---
{
  const w = computeLoudnessWindows(fakeBuffer([new Float32Array(0)], 1000));
  eq(w.peaks.length, 1, 'empty buffer still yields one window');
  eq(windowDbfs(w, 0), -Infinity, 'empty window silence');
  const segs = findLoudnessAnomalies(w, -40, -3);
  eq(segs, [], 'zero-duration anomaly segments suppressed');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
