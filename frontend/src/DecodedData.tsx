import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Database,
  Info,
  LoaderCircle,
  Pause,
  Play,
  X,
} from "lucide-react";

type CaptureInfo = {
  meta: Record<string, number | string>;
  duration_s: number;
};
type Column = { key: string; label: string };
type Page = {
  title: string;
  description: string;
  table: string;
  columns: Column[];
  rows: Record<string, string>[];
  total: number;
  offset: number;
  limit: number;
  catalog: { key: string; title: string; count: number }[];
};
const sections = [
  ["metadata", "文件元数据"],
  ["logs", "全部日志"],
  ["anchors", "音频时间锚点"],
  ["pcm", "PCM 逐帧数据"],
  ["trigger", "采集触发"],
  ["event", "本地检测事件"],
  ["clock", "事件时钟映射"],
  ["candidate", "候选峰"],
  ["pair", "配对诊断"],
  ["wave_clock", "波形时钟"],
  ["ui", "界面与设置"],
  ["status", "运行状态"],
  ["dsp", "DSP 诊断"],
];

export default function DecodedData({
  experimentId,
  boards,
}: {
  experimentId: string;
  boards: Record<string, CaptureInfo>;
}) {
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  return (
    <div className="decoded-page">
      <section className="panel audio-panel">
        <div className="panel-head">
          <div>
            <h2>
              <AudioLines size={19} />
              接收音频
            </h2>
            <p>收听 A / B 板保存的原始录音，或单独检查每个通道。</p>
          </div>
          <span className="section-tag">原始 PCM · 无损 WAV</span>
        </div>
        <div className="audio-grid">
          {(["A", "B"] as const).map((board) => (
            <AudioPlayer
              key={`${experimentId}-${board}`}
              board={board}
              experimentId={experimentId}
              info={boards[board]}
              register={(el) => {
                audioRefs.current[board] = el;
              }}
              onPlay={() => {
                for (const [other, el] of Object.entries(audioRefs.current)) {
                  if (other !== board) el?.pause();
                }
              }}
            />
          ))}
        </div>
        <div className="panel-foot">
          <Info size={15} />
          按各板录音起点独立播放，切换播放板卡时暂停另一板，不代表两板同步。保留原始采样率和幅度，高频信号可能不易听见。
        </div>
      </section>
      <details className="raw-data-disclosure">
        <summary>
          展开完整解析记录 <span>RAW DATA / 原始日志与逐帧数据</span>
        </summary>
        <DataExplorer key={experimentId} experimentId={experimentId} />
      </details>
    </div>
  );
}

function AudioPlayer({
  board,
  experimentId,
  info,
  register,
  onPlay,
}: {
  board: "A" | "B";
  experimentId: string;
  info: CaptureInfo;
  register: (el: HTMLAudioElement | null) => void;
  onPlay: () => void;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [channel, setChannel] = useState("stereo"),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState("");
  const url = `/api/experiments/${experimentId}/audio/${board}.wav?channel=${channel}`;
  async function toggle() {
    if (!ref.current) return;
    setError("");
    if (!ref.current.paused) ref.current.pause();
    else
      try {
        await ref.current.play();
      } catch {
        setError("音频暂时无法播放，请重试或下载 WAV 检查。");
      }
  }
  return (
    <div className={`audio-card board-${board.toLowerCase()}`}>
      <div className="audio-card-title">
        <span className="board-badge">{board}</span>
        <div>
          <h3>{board} 板录音</h3>
          <p>
            {(Number(info.meta.rate) / 1000).toLocaleString()} kHz · 16 bit ·{" "}
            {info.duration_s.toFixed(2)} s
          </p>
        </div>
        <span className={playing ? "playing-state active" : "playing-state"}>
          {playing ? "播放中" : "已暂停"}
        </span>
      </div>
      <div className="audio-options">
        <label htmlFor={`audio-channel-${board}`}>播放通道</label>
        <select
          id={`audio-channel-${board}`}
          aria-label={`${board} 板播放通道`}
          value={channel}
          onChange={(e) => {
            ref.current?.pause();
            setPlaying(false);
            setError("");
            setChannel(e.target.value);
          }}
        >
          <option value="stereo">双声道 · CH1 / CH2</option>
          <option value="1">仅 CH1</option>
          <option value="2">仅 CH2</option>
        </select>
      </div>
      <audio
        key={url}
        ref={(el) => {
          ref.current = el;
          register(el);
        }}
        controls
        preload="metadata"
        src={url}
        aria-label={`${board} 板音频播放器`}
        onPlay={() => {
          setPlaying(true);
          onPlay();
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setError("音频加载失败，请检查服务或重新选择通道。");
        }}
      />
      <div className="audio-actions">
        <button className="button" onClick={toggle}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? `暂停 ${board} 板` : `播放 ${board} 板`}
        </button>
        <a className="text-button" href={`${url}&download=true`}>
          <ArrowDownToLine size={15} />
          下载当前通道 WAV
        </a>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function DataExplorer({ experimentId }: { experimentId: string }) {
  const [board, setBoard] = useState("A"),
    [table, setTable] = useState("metadata");
  const [pageIndex, setPageIndex] = useState(0),
    [limit, setLimit] = useState(50),
    [jump, setJump] = useState("1");
  const [data, setData] = useState<Page | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setData(null);
    setSelected(null);
    setJump(String(pageIndex + 1));
    fetch(
      `/api/experiments/${experimentId}/decoded/${board}?table=${table}&offset=${pageIndex * limit}&limit=${limit}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json();
          throw new Error(
            typeof body.detail === "string" ? body.detail : "数据读取失败",
          );
        }
        return response.json() as Promise<Page>;
      })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [experimentId, board, table, pageIndex, limit]);
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));
  return (
    <section className="panel data-explorer">
      <div className="panel-head">
        <div>
          <h2>
            <Database size={19} />
            完整解析数据
          </h2>
          <p>
            所有字段保留原始数值精度。选择分类查看明细，点击一行可展开全部字段。
          </p>
        </div>
        <a
          className="button"
          href={`/api/experiments/${experimentId}/decoded/${board}?table=${table}&format=csv`}
        >
          <ArrowDownToLine size={16} />
          导出本类全部 CSV
        </a>
      </div>
      <div className="data-controls">
        <label>
          数据板卡
          <select
            aria-label="数据板卡"
            value={board}
            onChange={(e) => {
              setBoard(e.target.value);
              setPageIndex(0);
            }}
          >
            <option value="A">A 板</option>
            <option value="B">B 板</option>
          </select>
        </label>
        <label>
          数据分类
          <select
            aria-label="数据分类"
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              setPageIndex(0);
            }}
          >
            {sections.map(([key, title]) => (
              <option key={key} value={key}>
                {title}
                {data
                  ? ` (${data.catalog.find((c) => c.key === key)?.count ?? 0})`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          每页条数
          <select
            aria-label="每页条数"
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setPageIndex(0);
            }}
          >
            <option value="50">50 条</option>
            <option value="100">100 条</option>
            <option value="250">250 条</option>
          </select>
        </label>
        <span className="data-total">
          {busy ? (
            <>
              <LoaderCircle size={16} className="spin" />
              正在读取
            </>
          ) : (
            `共 ${(data?.total ?? 0).toLocaleString()} 条`
          )}
        </span>
      </div>
      {error ? (
        <div className="alert error" role="alert">
          {error}
        </div>
      ) : (
        <>
          <div className="data-description">
            <Info size={16} />
            <span>{data?.description ?? "正在加载原始解析记录…"}</span>
          </div>
          <div
            className="decoded-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="解析数据表，可横向滚动"
          >
            {data && (
              <table
                className={`decoded-table ${table === "logs" ? "raw-log-table" : ""}`}
              >
                <thead>
                  <tr>
                    {data.columns.map((c) => (
                      <th key={c.key}>
                        <span>{c.label}</span>
                        <code>{c.key}</code>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, i) => (
                    <tr
                      key={data.offset + i}
                      tabIndex={0}
                      aria-label={`查看第 ${data.offset + i + 1} 条记录`}
                      aria-selected={selected === row}
                      className={selected === row ? "selected" : ""}
                      onClick={() => setSelected(row)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelected(row);
                        }
                      }}
                    >
                      {data.columns.map((c) => (
                        <td
                          key={c.key}
                          className={c.key === "record" ? "raw-record" : ""}
                        >
                          {row[c.key]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {busy && (
              <div className="data-placeholder">
                <LoaderCircle size={24} className="spin" />
                正在读取 {board} 板数据…
              </div>
            )}
            {!busy && data?.total === 0 && (
              <div className="data-placeholder">
                本板未记录“{data.title}”数据，其他分类仍可查看。
              </div>
            )}
          </div>
          <div className="pagination">
            <span>
              {data?.total
                ? `${data.offset + 1}–${data.offset + data.rows.length} / ${data.total.toLocaleString()} 条`
                : "0 条记录"}
            </span>
            <div>
              <button
                className="button"
                disabled={busy || pageIndex === 0}
                onClick={() => setPageIndex((n) => n - 1)}
                aria-label="上一页"
              >
                <ChevronLeft size={16} />
                上一页
              </button>
              <span>
                第 {pageIndex + 1} / {pages} 页
              </span>
              <button
                className="button"
                disabled={busy || pageIndex + 1 >= pages}
                onClick={() => setPageIndex((n) => n + 1)}
                aria-label="下一页"
              >
                下一页
                <ChevronRight size={16} />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(jump);
                if (Number.isInteger(n) && n >= 1 && n <= pages)
                  setPageIndex(n - 1);
              }}
            >
              <label>
                跳至
                <input
                  aria-label="跳转页码"
                  type="number"
                  min={1}
                  max={pages}
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                  disabled={busy}
                />
              </label>
              <button className="button" disabled={busy}>
                转到
              </button>
            </form>
          </div>
          {selected && data && (
            <div className="record-detail">
              <div>
                <h3>记录字段详情</h3>
                <button
                  className="icon-button"
                  onClick={() => setSelected(null)}
                  aria-label="关闭记录详情"
                >
                  <X size={18} />
                </button>
              </div>
              <dl>
                {data.columns.map((c) => (
                  <div key={c.key}>
                    <dt>
                      {c.label}
                      <code>{c.key}</code>
                    </dt>
                    <dd>{selected[c.key]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      )}
    </section>
  );
}
