import type { Chapter, ChapterQualityMetrics } from '../types';
import { formatVttTime } from './time';

export function toWebVTT(chapters: Chapter[]): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const cues = sorted.map((c, i) => {
    const title = c.title.trim() || `Chapter ${i + 1}`;
    return `${i + 1}\n${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${title}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export interface JSONLoudnessConfig {
  windowSec: number;
  quietThresholdDbfs: number;
  loudThresholdDbfs: number;
}

export function toJSON(
  chapters: Chapter[],
  qualityById?: Map<string, ChapterQualityMetrics>,
  loudnessConfig?: JSONLoudnessConfig,
): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const data = sorted.map((c, i) => {
    const entry: Record<string, unknown> = {
      id: c.id,
      index: i + 1,
      title: c.title.trim() || `Chapter ${i + 1}`,
      start: Number(c.start.toFixed(3)),
      end: Number(c.end.toFixed(3)),
      duration: Number((c.end - c.start).toFixed(3)),
    };
    const q = qualityById?.get(c.id);
    if (q) {
      entry.quality = {
        loudnessStatus: q.loudnessStatus,
        meanDbfs: q.meanDbfs === null ? null : Number(q.meanDbfs.toFixed(2)),
        dynamicRangeDb: Number(q.dynamicRangeDb.toFixed(2)),
        quietDuration: Number(q.quietDuration.toFixed(3)),
        loudDuration: Number(q.loudDuration.toFixed(3)),
      };
    }
    return entry;
  });
  const payload: Record<string, unknown> = { version: 1, chapters: data };
  if (loudnessConfig) {
    payload.loudness = {
      windowSec: loudnessConfig.windowSec,
      quietThresholdDbfs: loudnessConfig.quietThresholdDbfs,
      loudThresholdDbfs: loudnessConfig.loudThresholdDbfs,
    };
  }
  return JSON.stringify(payload, null, 2);
}

export function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
