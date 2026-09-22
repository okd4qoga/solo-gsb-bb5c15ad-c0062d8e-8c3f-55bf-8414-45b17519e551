# 播客章节标注工作台 (Podcast Chapter Studio)

基于 **React + TypeScript + Web Audio API** 的网页播客章节标注工具：导入本地音频后，在可缩放波形上拖拽创建、移动、调整章节区间，自动吸附邻近边界并阻止重叠，支持键盘微调、章节搜索/排序、选中片段实时预览，并导出带章节标题的 **WebVTT** 和 **JSON** 文件。内置**静音切分建议**：按 100ms 窗口分析多声道 RMS，自动在静音中点给出候选切分边界，可一键应用。另内置**音量一致性质检**：按 200ms 窗口计算多声道合并峰值 dBFS，按窗口与章节的实际重叠时长加权汇总每章平均音量与动态范围；过轻 / 过响区间直接以不同颜色画在波形上，点击即可从该处预览。

## 一键启动（Docker）

```bash
docker compose up --build
```

启动后访问：**http://localhost:8080**（宿主机端口 `8080` → 容器内 nginx `80`）。

> 不使用 Compose 也可以：`docker build -t chapter-studio . && docker run -p 8080:80 chapter-studio`

## 本地开发

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 章节吸附/防重叠 + 静音切分 + 音量质检核心逻辑测试
npm run build      # 产出 dist/
```

## 功能与操作

- **导入音频**：点击「导入音频」或把音频文件拖入页面（MP3 / WAV / M4A / OGG 等浏览器可解码格式）。
- **波形缩放**：鼠标滚轮（以光标为锚点）或工具条滑块。
- **创建章节**：在波形空白处按下并拖出一个区间。
- **移动章节**：拖拽章节主体。
- **调整边界**：拖拽章节左右边缘（高亮手柄）。
- **吸附与防重叠**：拖动或调整时，边界在约 10px 内自动吸附到相邻章节边界或文件首尾；所有操作都被钳制在相邻章节之间，不会产生重叠。
- **跳转**：单击波形空白处移动播放头。
- **静音切分建议**：右侧面板调节「静音阈值」（-70 ~ -20 dB）与「最短静音」（0.2 ~ 3s），候选边界以橙色虚线旗标实时预览在波形上；候选只落在未被章节覆盖的空白区间，且自动过滤会产生短于 0.2s 章节的边界。点击「应用全部候选」即在空白区间批量生成章节，已有章节保持不变、结果不重叠。
- **音量一致性质检**：右侧面板调节「过轻阈值」（默认 -45 dBFS，-70 ~ -10）与「过响阈值」（默认 -3 dBFS，-20 ~ 0）。波形上**紫色色块表示过轻、红色色块表示过响**（连续异常窗口自动合并为区间）；章节列表与右侧详情显示每章状态徽标（正常 / 过轻 / 过响 / 全静音）、加权平均 dBFS 与动态范围。点击波形上的异常色块即从该处开始预览（位于章节内则播到章节尾）；列表项的 ⚠ 按钮可从该章首个异常处预览。阈值变化只重算判定，不重新解码音频。
- **搜索 / 排序**：左侧面板按标题搜索，可按开始时间、标题或时长排序。
- **预览**：列表项 ▶、「预览章节」按钮或快捷键 `P` 播放选中章节区间（到点自动停止）。

### 快捷键

| 按键 | 功能 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `N` | 在播放头处新建章节（自动寻找空档） |
| `P` | 预览选中章节 |
| `←` / `→` | 移动选中章节 ±0.05s（加 `Shift` 为 ±1s） |
| `Alt` + `←` / `→` | 微调选中章节起点 |
| `Ctrl` + `←` / `→` | 微调选中章节终点 |
| `Delete` / `Backspace` | 删除选中章节 |
| `Esc` | 取消选中 |

### 导出

- **WebVTT**（`*.vtt`）：标准 `WEBVTT`  cues，按开始时间排序，章节标题作为 cue 文本。
- **JSON**（`*.chapters.json`）：`{ version, loudness: { windowSec, quietThresholdDbfs, loudThresholdDbfs }, chapters: [{ id, index, title, start, end, duration, quality: { loudnessStatus, meanDbfs, dynamicRangeDb, quietDuration, loudDuration } }] }`，时间单位为秒。`loudnessStatus` 为 `ok` / `quiet` / `loud` / `silent` 之一；全静音章节的 `meanDbfs` 为 `null`（不会出现 `NaN` / `Infinity`），动态范围、过轻/过响累计时长按 200ms 窗口与章节的实际重叠秒数加权统计。

## 技术要点

- 波形为自绘 Canvas：解码后预计算 200 peaks/s 的 min/max 峰值，任意缩放级别下按像素列聚合渲染，长音频也流畅。
- 静音分析复用已解码的 `AudioBuffer`（不重新解码）：100ms 窗口多声道合并 RMS 只在导入时计算一次；阈值 / 最短静音变化时仅重算静音段与候选边界（`src/audio/silence.ts` 纯函数，由 `scripts/test-silence.ts` 覆盖）。
- 音量质检同样复用同一份已解码 PCM：200ms 窗口多声道合并峰值（max |sample|）dBFS 只在导入时单遍计算一次（`src/audio/loudness.ts`）；每章平均 dBFS 与动态范围按**窗口与章节的实际重叠时长**加权——跨章节窗口被按重叠切分，不会被错误归属；全静音章节输出 `silent` + `null` 均值（静音在均值中排除、在动态范围中按 -100 dBFS 垫底），极短 / 零时长章节与零长度文件均不产生 NaN。拖动阈值滑块仅重跑分类与色块合并。纯函数由 `scripts/test-loudness.ts` 覆盖。
- 吸附 / 防重叠逻辑集中在 `src/utils/chapterOps.ts` 纯函数中（`moveChapter` / `resizeChapter` / `createChapterInGap` / `findFreeGap`），由 `scripts/test-chapterOps.ts` 覆盖。
- 播放基于 Web Audio API：`AudioBufferSourceNode` 支持带结束点的片段预览，播放头由 rAF 驱动。
- Docker 为多阶段构建：`node:20-alpine` 构建 → `nginx:1.27-alpine` 托管静态文件。

## 目录结构

```
├── Dockerfile              # 多阶段构建（build → nginx）
├── docker-compose.yml      # 单服务，8080:80
├── nginx.conf              # SPA 回退 + 静态资源缓存
├── src/
│   ├── audio/              # AudioEngine（播放/片段预览）、peaks（波形峰值）、silence（静音 RMS/候选边界）、loudness（200ms 峰值 dBFS / 章节加权质检）
│   ├── components/         # Waveform / ChapterList / TransportBar / SilencePanel / LoudnessPanel
│   ├── hooks/useChapters.ts
│   ├── utils/chapterOps.ts # 吸附、防重叠、空档查找（纯函数）
│   └── utils/export.ts     # WebVTT / JSON 导出（JSON 附带音量质检指标）
└── scripts/                # test-chapterOps.ts、test-silence.ts、test-loudness.ts
```
