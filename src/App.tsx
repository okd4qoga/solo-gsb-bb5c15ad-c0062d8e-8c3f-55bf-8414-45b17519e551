import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine } from './audio/AudioEngine';
import {
  LOUDNESS_WINDOW_SEC,
  computeDbfsWindows,
  evaluateAllChapters,
  findLoudnessSegments,
  type LoudnessThresholds,
} from './audio/loudness';
import { computePeaks } from './audio/peaks';
import {
  RMS_WINDOW_SEC,
  computeRmsWindows,
  findSilenceSegments,
  splitGapsAtBoundaries,
  suggestSplitBoundaries,
} from './audio/silence';
import { Waveform } from './components/Waveform';
import { ChapterList } from './components/ChapterList';
import { LoudnessPanel } from './components/LoudnessPanel';
import { SilencePanel } from './components/SilencePanel';
import { TransportBar } from './components/TransportBar';
import { useChapters } from './hooks/useChapters';
import type { Chapter, Peaks } from './types';
import { downloadFile, toJSON, toWebVTT } from './utils/export';
import { formatTime } from './utils/time';

const NUDGE_FINE = 0.05;
const NUDGE_COARSE = 1;

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const [fileName, setFileName] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(50);
  const [follow, setFollow] = useState(true);
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // silence-split suggestions
  const [rmsWindows, setRmsWindows] = useState<Float32Array | null>(null);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-40);
  const [minSilenceSec, setMinSilenceSec] = useState(0.5);
  const [showSuggestions, setShowSuggestions] = useState(true);

  // chapter loudness QC (200ms dBFS windows computed once at import)
  const [dbfsWindows, setDbfsWindows] = useState<Float32Array | null>(null);
  const [loudnessThresholds, setLoudnessThresholds] = useState<LoudnessThresholds>({
    quietDb: -30,
    loudDb: -6,
  });
  const [showLoudness, setShowLoudness] = useState(true);

  const chaptersApi = useChapters(duration);
  const { chapters, selected, selectedId, reset: resetChapters } = chaptersApi;

  // recompute candidates whenever params or chapters change
  const suggestions = useMemo(() => {
    if (!rmsWindows || duration <= 0) return [];
    const thresholdLinear = Math.pow(10, silenceThresholdDb / 20);
    const segments = findSilenceSegments(
      rmsWindows,
      RMS_WINDOW_SEC,
      thresholdLinear,
      minSilenceSec,
      duration,
    );
    return suggestSplitBoundaries(segments, chapters, duration);
  }, [rmsWindows, silenceThresholdDb, minSilenceSec, chapters, duration]);

  const applyAllSuggestions = useCallback(() => {
    const ranges = splitGapsAtBoundaries(chapters, suggestions, duration);
    chaptersApi.addMany(ranges);
  }, [chapters, suggestions, duration, chaptersApi]);

  // Loudness QC: thresholds/chapters only re-run the classification over the
  // cached 200ms dBFS windows — the decoded PCM is never scanned again.
  const chapterLoudness = useMemo(() => {
    if (!dbfsWindows) return null;
    return evaluateAllChapters(
      chapters,
      dbfsWindows,
      LOUDNESS_WINDOW_SEC,
      duration,
      loudnessThresholds,
    );
  }, [dbfsWindows, chapters, duration, loudnessThresholds]);

  const loudnessSegments = useMemo(() => {
    if (!dbfsWindows || !showLoudness) return [];
    return findLoudnessSegments(dbfsWindows, LOUDNESS_WINDOW_SEC, duration, loudnessThresholds);
  }, [dbfsWindows, showLoudness, duration, loudnessThresholds]);

  const changeQuietThreshold = useCallback((v: number) => {
    setLoudnessThresholds((t) => ({ ...t, quietDb: Math.min(v, t.loudDb - 1) }));
  }, []);
  const changeLoudThreshold = useCallback((v: number) => {
    setLoudnessThresholds((t) => ({ ...t, loudDb: Math.max(v, t.quietDb + 1) }));
  }, []);

  // playback clock
  useEffect(() => {
    engine.onEnded = () => setPlaying(false);
    let raf = 0;
    const tick = () => {
      if (engine.playing) {
        setPlayhead(engine.getTime());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  useEffect(() => () => engine.dispose(), [engine]);

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      setDecoding(true);
      try {
        const buffer = await engine.decode(file);
        resetChapters();
        setPeaks(computePeaks(buffer));
        // reuse the decoded buffer for silence analysis (no re-decode)
        setRmsWindows(computeRmsWindows(buffer));
        // reuse the same decoded PCM once more for 200ms loudness windows
        setDbfsWindows(computeDbfsWindows(buffer));
        setDuration(buffer.duration);
        setFileName(file.name);
        setPlayhead(0);
        setPlaying(false);
      } catch {
        setError('无法解码该音频文件，请换用常见格式（MP3 / WAV / M4A / OGG）。');
      } finally {
        setDecoding(false);
      }
    },
    [engine, resetChapters],
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void loadFile(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void loadFile(f);
  };

  const seek = useCallback(
    (t: number) => {
      const wasPlaying = engine.playing;
      engine.stop();
      setPlayhead(t);
      if (wasPlaying) {
        engine.play(t);
        setPlaying(true);
      } else {
        setPlaying(false);
      }
    },
    [engine],
  );

  const togglePlay = useCallback(() => {
    if (!engine.hasBuffer) return;
    if (engine.playing) {
      const t = engine.pause();
      setPlayhead(t);
      setPlaying(false);
    } else {
      engine.play(playhead >= duration - 0.05 ? 0 : playhead);
      setPlaying(true);
    }
  }, [engine, playhead, duration]);

  const previewChapter = useCallback(
    (start: number, end: number) => {
      if (!engine.hasBuffer) return;
      engine.play(start, end);
      setPlayhead(start);
      setPlaying(true);
    },
    [engine],
  );

  const previewSelection = useCallback(() => {
    if (selected) previewChapter(selected.start, selected.end);
  }, [selected, previewChapter]);

  /** Preview starting at a point (clicking an abnormal band). */
  const previewFrom = useCallback(
    (t: number) => {
      if (!engine.hasBuffer) return;
      engine.play(t);
      setPlayhead(t);
      setPlaying(true);
    },
    [engine],
  );

  /** From the list status pill: preview the chapter from its first issue. */
  const previewChapterIssue = useCallback(
    (c: Chapter) => {
      if (!engine.hasBuffer) return;
      const q = chapterLoudness?.get(c.id);
      previewChapter(q?.firstIssueAt ?? c.start, c.end);
    },
    [engine, chapterLoudness, previewChapter],
  );

  const addAtPlayhead = useCallback(() => {
    chaptersApi.createAtPlayhead(playhead);
  }, [chaptersApi, playhead]);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      if (!peaks) return;
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE_FINE;
      const sel = chaptersApi.selected;
      let handled = true;

      if (e.key === ' ') {
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!sel) return;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (e.altKey) {
          chaptersApi.resize(sel.id, 'start', sel.start + dir * step, 0);
        } else if (e.ctrlKey || e.metaKey) {
          chaptersApi.resize(sel.id, 'end', sel.end + dir * step, 0);
        } else {
          chaptersApi.move(sel.id, sel.start + dir * step, 0);
        }
      } else if (e.key === 'n' || e.key === 'N') {
        addAtPlayhead();
      } else if (e.key === 'p' || e.key === 'P') {
        previewSelection();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        chaptersApi.remove(sel.id);
      } else if (e.key === 'Escape') {
        chaptersApi.select(null);
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peaks, chaptersApi, togglePlay, previewSelection, addAtPlayhead]);

  const baseName = (fileName ?? 'podcast').replace(/\.[^.]+$/, '');

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="app-header">
        <h1>播客章节标注工作台</h1>
        <label className="file-button">
          导入音频
          <input type="file" accept="audio/*" onChange={onFileInput} hidden />
        </label>
        {fileName && <span className="file-name">{fileName}</span>}
        <span className="spacer" />
        <button
          disabled={chapters.length === 0}
          onClick={() => downloadFile(`${baseName}.vtt`, toWebVTT(chapters), 'text/vtt')}
        >
          导出 WebVTT
        </button>
        <button
          disabled={chapters.length === 0}
          onClick={() =>
            downloadFile(
              `${baseName}.chapters.json`,
              toJSON(chapters, { loudness: chapterLoudness, thresholds: loudnessThresholds }),
              'application/json',
            )
          }
        >
          导出 JSON
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {!peaks ? (
        <div className="drop-zone">
          {decoding ? '正在解码音频…' : '点击「导入音频」或将音频文件拖入页面'}
        </div>
      ) : (
        <>
          <TransportBar
            loaded
            playing={playing}
            playhead={playhead}
            duration={duration}
            pxPerSec={pxPerSec}
            follow={follow}
            hasSelection={selected !== null}
            onTogglePlay={togglePlay}
            onPreviewSelection={previewSelection}
            onAddAtPlayhead={addAtPlayhead}
            onZoom={setPxPerSec}
            onToggleFollow={() => setFollow((f) => !f)}
          />
          <Waveform
            peaks={peaks}
            chapters={chapters}
            selectedId={selectedId}
            playhead={playhead}
            pxPerSec={pxPerSec}
            follow={follow && playing}
            suggestions={showSuggestions ? suggestions : []}
            loudnessSegments={loudnessSegments}
            onZoom={setPxPerSec}
            onSeek={seek}
            onPreviewSegment={previewFrom}
            onSelect={chaptersApi.select}
            onCreateFromDrag={chaptersApi.createFromDrag}
            onMove={chaptersApi.move}
            onResize={chaptersApi.resize}
          />
          <div className="main-body">
            <ChapterList
              chapters={chapters}
              selectedId={selectedId}
              loudness={chapterLoudness}
              onSelect={(id) => {
                chaptersApi.select(id);
                const c = chapters.find((x) => x.id === id);
                if (c) seek(c.start);
              }}
              onPreview={(c) => previewChapter(c.start, c.end)}
              onPreviewIssue={previewChapterIssue}
              onRename={chaptersApi.rename}
              onRemove={chaptersApi.remove}
            />
            <aside className="detail-panel">
              <SilencePanel
                thresholdDb={silenceThresholdDb}
                minSilenceSec={minSilenceSec}
                show={showSuggestions}
                candidateCount={suggestions.length}
                onThresholdDbChange={setSilenceThresholdDb}
                onMinSilenceSecChange={setMinSilenceSec}
                onToggleShow={() => setShowSuggestions((s) => !s)}
                onApplyAll={applyAllSuggestions}
              />
              <LoudnessPanel
                thresholds={loudnessThresholds}
                show={showLoudness}
                available={dbfsWindows !== null}
                statuses={chapters.map((c) => chapterLoudness?.get(c.id)?.status ?? 'unknown')}
                onQuietDbChange={changeQuietThreshold}
                onLoudDbChange={changeLoudThreshold}
                onToggleShow={() => setShowLoudness((s) => !s)}
              />
              {selected ? (
                <>
                  <h2>选中章节</h2>
                  <label>
                    标题
                    <input
                      value={selected.title}
                      onChange={(e) => chaptersApi.rename(selected.id, e.target.value)}
                    />
                  </label>
                  <div className="detail-times">
                    <span>开始 {formatTime(selected.start)}</span>
                    <span>结束 {formatTime(selected.end)}</span>
                    <span>时长 {(selected.end - selected.start).toFixed(2)}s</span>
                  </div>
                  {(() => {
                    const q = chapterLoudness?.get(selected.id);
                    if (!q) return null;
                    const mean = q.meanDbfs === null ? '-∞' : `${q.meanDbfs.toFixed(1)} dBFS`;
                    return (
                      <div className={`qc-detail qc-${q.status}`}>
                        <span>
                          质检状态：
                          {q.status === 'ok'
                            ? '正常'
                            : q.status === 'quiet'
                              ? '过轻'
                              : q.status === 'loud'
                                ? '过响'
                                : '区间过短'}
                          {q.allSilent ? '（全静音）' : ''}
                        </span>
                        <span>
                          平均 {mean} · 动态范围 {q.rangeDb.toFixed(1)} dB
                          {q.minDbfs !== null && q.maxDbfs !== null
                            ? `（${q.minDbfs.toFixed(1)} ~ ${q.maxDbfs.toFixed(1)} dBFS）`
                            : ''}
                        </span>
                        {(q.quietCoverage > 0 || q.loudCoverage > 0) && (
                          <button
                            onClick={() => previewChapterIssue(selected)}
                            title="从首个异常窗口开始播放"
                          >
                            ⚠ 从异常处预览
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  <button className="primary" onClick={previewSelection}>
                    ▶ 预览该章节
                  </button>
                </>
              ) : (
                <p className="empty-hint">点击波形中的章节或列表项以编辑。</p>
              )}
              <div className="shortcut-help">
                <h3>快捷键</h3>
                <ul>
                  <li><kbd>空格</kbd> 播放 / 暂停</li>
                  <li><kbd>N</kbd> 播放头处新建章节</li>
                  <li><kbd>P</kbd> 预览选中章节</li>
                  <li><kbd>←</kbd><kbd>→</kbd> 移动选中章节（±0.05s，<kbd>Shift</kbd> ±1s）</li>
                  <li><kbd>Alt</kbd>+<kbd>←</kbd><kbd>→</kbd> 调整起点</li>
                  <li><kbd>Ctrl</kbd>+<kbd>←</kbd><kbd>→</kbd> 调整终点</li>
                  <li><kbd>Delete</kbd> 删除选中章节</li>
                  <li>滚轮：缩放波形；拖拽空白：创建章节</li>
                </ul>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
