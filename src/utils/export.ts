import type { Chapter } from '../types';
import { formatVttTime } from './time';

export function toWebVTT(chapters: Chapter[]): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const cues = sorted.map((c, i) => {
    const title = c.title.trim() || `Chapter ${i + 1}`;
    return `${i + 1}\n${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${title}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function toJSON(chapters: Chapter[]): string {
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  const data = sorted.map((c, i) => ({
    id: c.id,
    index: i + 1,
    title: c.title.trim() || `Chapter ${i + 1}`,
    start: Number(c.start.toFixed(3)),
    end: Number(c.end.toFixed(3)),
    duration: Number((c.end - c.start).toFixed(3)),
  }));
  return JSON.stringify({ version: 1, chapters: data }, null, 2);
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
