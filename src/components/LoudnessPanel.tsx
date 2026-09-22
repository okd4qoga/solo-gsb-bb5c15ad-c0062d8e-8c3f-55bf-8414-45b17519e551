interface LoudnessPanelProps {
  quietThresholdDb: number;
  loudThresholdDb: number;
  show: boolean;
  /** chapters with any kind of loudness problem */
  flaggedCount: number;
  chapterCount: number;
  onQuietThresholdDbChange: (v: number) => void;
  onLoudThresholdDbChange: (v: number) => void;
  onToggleShow: () => void;
}

/**
 * Chapter loudness consistency QC: tunable "too quiet" / "too loud"
 * dBFS thresholds. Analysis windows are computed once at import; moving
 * these sliders only re-runs the classification (no audio re-decode).
 */
export function LoudnessPanel(props: LoudnessPanelProps) {
  const { quietThresholdDb, loudThresholdDb, show, flaggedCount, chapterCount } = props;
  return (
    <section className="loudness-panel">
      <h2>音量一致性质检</h2>
      <label className="silence-toggle">
        <input type="checkbox" checked={show} onChange={props.onToggleShow} />
        在波形上标出异常区间
      </label>
      <label className="silence-field">
        <span>
          过轻阈值 <b className="qc-quiet">{quietThresholdDb} dB</b>
        </span>
        <input
          type="range"
          min={-70}
          max={-10}
          step={1}
          value={quietThresholdDb}
          onChange={(e) => props.onQuietThresholdDbChange(Number(e.target.value))}
        />
      </label>
      <label className="silence-field">
        <span>
          过响阈值 <b className="qc-loud">{loudThresholdDb} dB</b>
        </span>
        <input
          type="range"
          min={-20}
          max={0}
          step={1}
          value={loudThresholdDb}
          onChange={(e) => props.onLoudThresholdDbChange(Number(e.target.value))}
        />
      </label>
      <div className="silence-info">
        {chapterCount === 0
          ? '还没有章节'
          : flaggedCount > 0
            ? `${flaggedCount} / ${chapterCount} 章音量异常（点击波形色块或列表定位）`
            : `${chapterCount} 章均在阈值范围内`}
      </div>
    </section>
  );
}
