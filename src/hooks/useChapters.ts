import { useCallback, useMemo, useState } from 'react';
import type { Chapter } from '../types';
import { uid } from '../utils/time';
import {
  createChapterInGap,
  findFreeGap,
  moveChapter,
  resizeChapter,
  sorted,
} from '../utils/chapterOps';

export function useChapters(duration: number) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const addChapter = useCallback(
    (start: number, end: number, title?: string): string => {
      const id = uid();
      setChapters((prev) => {
        const n = prev.length + 1;
        return [...prev, { id, title: title ?? `章节 ${n}`, start, end }];
      });
      setSelectedId(id);
      return id;
    },
    [],
  );

  /** Append several chapters at once (used by silence-split apply). */
  const addMany = useCallback((ranges: { start: number; end: number }[]) => {
    if (ranges.length === 0) return;
    setChapters((prev) => {
      const next = [...prev];
      ranges.forEach((r, i) => {
        next.push({
          id: uid(),
          title: `章节 ${prev.length + i + 1}`,
          start: r.start,
          end: r.end,
        });
      });
      return next;
    });
  }, []);

  /** Create from a drag range; returns new id or null if no room. */
  const createFromDrag = useCallback(
    (a: number, b: number, snapThreshold: number): string | null => {
      const range = createChapterInGap(chapters, a, b, duration, snapThreshold);
      if (!range) return null;
      return addChapter(range.start, range.end);
    },
    [chapters, duration, addChapter],
  );

  /** Create a chapter of default length at the playhead. */
  const createAtPlayhead = useCallback(
    (at: number, len = 5): string | null => {
      const gap = findFreeGap(chapters, at, len, duration);
      if (!gap) return null;
      return addChapter(gap.start, gap.end);
    },
    [chapters, duration, addChapter],
  );

  const move = useCallback(
    (id: string, desiredStart: number, snapThreshold: number) => {
      setChapters((prev) => {
        const r = moveChapter(prev, id, desiredStart, duration, snapThreshold);
        if (!r) return prev;
        return prev.map((c) => (c.id === id ? { ...c, ...r } : c));
      });
    },
    [duration],
  );

  const resize = useCallback(
    (id: string, edge: 'start' | 'end', desired: number, snapThreshold: number) => {
      setChapters((prev) => {
        const r = resizeChapter(prev, id, edge, desired, duration, snapThreshold);
        if (!r) return prev;
        return prev.map((c) => (c.id === id ? { ...c, ...r } : c));
      });
    },
    [duration],
  );

  const rename = useCallback((id: string, title: string) => {
    setChapters((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  const remove = useCallback(
    (id: string) => {
      setChapters((prev) => prev.filter((c) => c.id !== id));
      setSelectedId((sel) => (sel === id ? null : sel));
    },
    [],
  );

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const reset = useCallback(() => {
    setChapters([]);
    setSelectedId(null);
  }, []);

  const selected = useMemo(
    () => chapters.find((c) => c.id === selectedId) ?? null,
    [chapters, selectedId],
  );

  const sortedChapters = useMemo(() => sorted(chapters), [chapters]);

  return {
    chapters,
    sortedChapters,
    selected,
    selectedId,
    select,
    addChapter,
    addMany,
    createFromDrag,
    createAtPlayhead,
    move,
    resize,
    rename,
    remove,
    reset,
  };
}

export type ChaptersApi = ReturnType<typeof useChapters>;
