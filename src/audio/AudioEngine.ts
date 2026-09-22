/**
 * Thin wrapper around Web Audio API for buffer playback.
 * Supports full-file playback and segment (chapter) preview.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** ctx.currentTime at which playback started */
  private startedAt = 0;
  /** buffer offset at which playback started */
  private offset = 0;
  private stopAt: number | null = null;
  private stopTimer: number | null = null;
  playing = false;
  onEnded: (() => void) | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  async decode(file: File): Promise<AudioBuffer> {
    const ctx = this.ensureCtx();
    const data = await file.arrayBuffer();
    this.stop();
    this.buffer = await ctx.decodeAudioData(data);
    return this.buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get hasBuffer(): boolean {
    return this.buffer !== null;
  }

  /** Current playback position in seconds (buffer timeline). */
  getTime(): number {
    if (!this.playing || !this.ctx) return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    return Math.min(t, this.duration);
  }

  play(from: number, to?: number): void {
    if (!this.buffer) return;
    const ctx = this.ensureCtx();
    this.stopSource();
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain!);
    const dur = this.buffer.duration;
    const start = Math.max(0, Math.min(from, dur));
    this.offset = start;
    this.startedAt = ctx.currentTime;
    this.stopAt = to !== undefined ? Math.min(to, dur) : null;

    source.onended = () => {
      // onended also fires on manual stop(); guard with playing flag
      if (this.playing) {
        this.playing = false;
        this.offset = this.stopAt ?? this.offset;
        this.clearTimer();
        this.onEnded?.();
      }
    };

    if (this.stopAt !== null && this.stopAt > start) {
      source.start(0, start, this.stopAt - start);
    } else {
      source.start(0, start);
    }
    this.source = source;
    this.playing = true;
  }

  pause(): number {
    const t = this.getTime();
    this.stop();
    this.offset = t;
    return t;
  }

  stop(): void {
    this.playing = false;
    this.stopSource();
    this.clearTimer();
  }

  private stopSource(): void {
    if (this.source) {
      const s = this.source;
      this.source = null;
      this.playing = false;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
  }

  private clearTimer(): void {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
