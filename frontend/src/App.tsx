import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeftRight,
  AudioLines,
  Check,
  ChevronRight,
  Clock3,
  Database,
  FileUp,
  FlaskConical,
  FolderOpen,
  Info,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import type { Data, Layout } from "plotly.js";
import Chart from "./Chart";
import DecodedData from "./DecodedData";
import AIAnalysis from "./AIAnalysis";
import Admin from "./Admin";
import Archive from "./Archive";
import { usePageNavigation } from "./usePageNavigation";
import { waveEvents, type EventMarker } from "./waveEvents";
import "./style.css";
import "./rhine.css";
import "./archive-room.css";

type Raw = Record<string, string>;
type EventRecord = Raw & {
  event: string;
  local_ns: string;
  locked: string;
  clock: Raw | null;
  candidates: Raw[];
  epoch: number | null;
};
type Pair = {
  index: number;
  time_s: number;
  outcome: number;
  reason_label: string;
  distance_mm: number | null;
  delay_us: number;
  arrival_delta_us: number;
  raw: Raw;
  events: Record<string, EventRecord | null>;
};
type Stats = {
  pairs: number;
  accepted: number;
  ambiguous: number;
  rejected: number;
  mean_mm: number | null;
  std_mm: number | null;
  temperature_c: number;
};
type Board = {
  meta: Record<string, number | string>;
  duration_s: number;
  counts: Record<string, number>;
  status: Raw[];
  dsp: Raw[];
  clock_events: { time_s: number; offset_us: number; locked: boolean }[];
  discontinuities: number;
  epochs: number[];
  event_markers: EventMarker[];
};
type Report = {
  analysis_version: string;
  base_master_ns: string;
  duration_s: number;
  boards: Record<string, Board>;
  pairs: Pair[];
  warnings: string[];
  stats: Stats;
  distance_note: string;
  alignment: { method: string; b_ranges: number[][] };
};
type Experiment = {
  id: string;
  name: string;
  created_at: string;
  status: string;
  notes: string;
  truth_mm: number | null;
  error: string | null;
  summary: Stats | null;
  report?: Report;
  duplicate_count?: number;
};
type Wave = {
  traces: {
    board: string;
    channel: number;
    x: (number | null)[];
    y: (number | null)[];
  }[];
  mode: string;
  start: number;
  end: number;
};
const colors = { A: "#b76b38", B: "#3e7377" };
const pageGroup = (page: string) =>
  ["analysis", "health", "decoded", "ai"].includes(page) ? "analysis" : page;
const fmt = (value: number | null | undefined, digits = 2) =>
  value == null
    ? "—"
    : value.toLocaleString("zh-CN", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });
const statusLabel: Record<string, string> = {
  ready: "已解析",
  failed: "解析失败",
  processing: "正在解析",
  queued: "等待解析",
};
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(url, options);
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const e = await r.json();
      msg = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

export default function App() {
  const [serverMode, setServerMode] = useState(false);
  const [experiments, setExperiments] = useState<Experiment[]>([]),
    [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Experiment | null>(null),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false),
    [editing, setEditing] = useState(false);
  const { page: tab, navigate: setTab, surface } = usePageNavigation(
    "archive",
    pageGroup,
  );
  const [pairIndex, setPairIndex] = useState<number | null>(null),
    [range, setRange] = useState<[number, number] | null>(null);
  const [wave, setWave] = useState<Wave | null>(null),
    [waveBusy, setWaveBusy] = useState(false),
    [waveError, setWaveError] = useState("");
  const [mode, setMode] = useState("master"),
    [channels, setChannels] = useState([true, false, true, false]);
  const [showEvents, setShowEvents] = useState(true);
  const [compared, setCompared] = useState<string[]>([]);
  const selectedRef = useRef("");
  selectedRef.current = selectedId;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);
  async function refresh() {
    try {
      const rows = await request<Experiment[]>("/api/experiments");
      setExperiments((old) =>
        JSON.stringify(old) === JSON.stringify(rows) ? old : rows,
      );
      if (!rows.some((row) => row.id === selectedRef.current))
        setSelectedId(rows[0]?.id ?? "");
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    request<{ mode: string }>("/api/health")
      .then((health) => setServerMode(health.mode === "server"))
      .catch(() => {});
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setDetail(null);
    setPairIndex(null);
    setRange(null);
    setWave(null);
    setMode("master");
  }, [selectedId]);
  const currentStatus = experiments.find((e) => e.id === selectedId)?.status;
  useEffect(() => {
    if (!selectedId) return;
    const c = new AbortController();
    request<Experiment>(`/api/experiments/${selectedId}`, { signal: c.signal })
      .then(setDetail)
      .catch((e) => {
        if (e.name !== "AbortError") setError(String(e));
      });
    return () => c.abort();
  }, [selectedId, currentStatus]);
  const report = detail?.report;
  const duration =
    mode === "local" && report
      ? Math.max(...Object.values(report.boards).map((b) => b.duration_s))
      : report?.duration_s || 16;
  useEffect(() => {
    if (!report || !selectedId) return;
    const c = new AbortController();
    setWaveBusy(true);
    setWaveError("");
    const timer = setTimeout(() => {
      const lo = Math.max(0, range?.[0] ?? 0),
        hi = Math.max(lo + 0.00001, Math.min(duration, range?.[1] ?? duration));
      request<Wave>(
        `/api/experiments/${selectedId}/waveform?start=${lo}&end=${hi}&pixels=900&mode=${mode}`,
        { signal: c.signal },
      )
        .then(setWave)
        .catch((e) => {
          if (e.name !== "AbortError") setWaveError(String(e));
        })
        .finally(() => {
          if (!c.signal.aborted) setWaveBusy(false);
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [selectedId, report, range, mode, duration]);
  function changeRange(next: [number, number] | null) {
    if (next) {
      next = [Math.max(0, next[0]), Math.min(duration, next[1])];
      if (next[1] <= next[0]) return;
    }
    setRange((old) =>
      JSON.stringify(old) === JSON.stringify(next) ? old : next,
    );
  }
  function choosePair(index: number) {
    setPairIndex(index);
    const p = report?.pairs[index];
    if (p) {
      setMode("master");
      setRange([
        Math.max(0, p.time_s - 0.1),
        Math.min(report!.duration_s, p.time_s + 0.16),
      ]);
    }
  }
  const pair = pairIndex != null ? report?.pairs[pairIndex] : null;
  const stats = report?.stats;
  const layout: Partial<Layout> = {
    xaxis: {
      range: range ?? [0, duration],
      title: {
        text:
          mode === "master" ? "相对主时钟 / s" : "各板录音起点 / s（未对齐）",
      },
      gridcolor: "#dedfd2",
      zeroline: false,
    },
    uirevision: selectedId + mode,
  };
  const pairTraces: Data[] = report
    ? [
        {
          type: "scatter",
          mode: "lines",
          x: report.pairs.map((p) => p.time_s),
          y: report.pairs.map((p) => (p.outcome === 1 ? p.distance_mm : null)),
          line: { color: "#bfc1ad", width: 1 },
          hoverinfo: "skip",
        },
        ...[1, 2, 0].map((outcome) => ({
          type: "scatter" as const,
          mode: "markers" as const,
          name: outcome === 1 ? "唯一配对" : outcome === 2 ? "歧义" : "不一致",
          x: report.pairs
            .filter((p) => p.outcome === outcome)
            .map((p) => p.time_s),
          y: report.pairs
            .filter((p) => p.outcome === outcome)
            .map((p) => p.distance_mm),
          customdata: report.pairs
            .filter((p) => p.outcome === outcome)
            .map((p) => p.index),
          marker: {
            color:
              outcome === 1 ? "#708b70" : outcome === 2 ? "#b6a04f" : "#b57470",
            size: 9,
            symbol: outcome === 1 ? "circle" : "diamond",
          },
          hovertemplate:
            "%{x:.6f} s<br>%{y:.3f} mm<extra>%{fullData.name}</extra>",
        })),
      ]
    : [];
  const waveTraces: Data[] = (wave?.traces ?? [])
    .filter((_, i) => channels[i])
    .map((t) => ({
      type: "scatter",
      mode: "lines",
      name: `${t.board} · CH${t.channel}`,
      opacity: 0.6,
      x: t.x,
      y: t.y,
      line: {
        color: colors[t.board as "A" | "B"],
        width: t.channel === 1 ? 1 : 0.7,
        dash: t.channel === 1 ? "solid" : "dot",
      },
      connectgaps: false,
      hovertemplate: "%{x:.6f} s<br>%{y} PCM<extra>%{fullData.name}</extra>",
    }));
  const eventPlot = report
    ? waveEvents(
        report.boards,
        report.pairs,
        mode,
        range ?? [0, duration],
        channels,
        pairIndex,
        showEvents,
      )
    : { events: [], traces: [], shapes: [], unpositioned: 0 };
  const arrivalPair =
    mode === "master" &&
    typeof pair?.arrival_delta_us === "number" &&
    pair?.events.A?.locked === "1" &&
    pair?.events.B?.locked === "1"
      ? pair
      : null;
  const readyCount = experiments.filter((e) => e.status === "ready").length;
  return (
    <div
      ref={surface}
      className={`app-shell ${tab === "archive" ? "is-archive" : "is-workbench"}`}
    >
      <aside className="sidebar">
        <div className="sidebar-brand">
          <button
            className="terminal-brand"
            onClick={() => setTab("archive")}
            aria-label="返回实验档案"
          >
            <AudioLines size={25} />
            <span>
              RANGING <b>LAB</b>
              <small>声学实验分析终端</small>
            </span>
          </button>
        </div>
        <div className="workspace-label">
          ANALYSIS TERMINAL <span>{serverMode ? "CLOUD" : "LOCAL"}</span>
        </div>
        <button
          className={`nav-item ${!["compare", "admin", "archive"].includes(tab) ? "active" : ""}`}
          onClick={() => setTab("analysis")}
        >
          <FlaskConical size={17} />
          实验分析<span>{experiments.length}</span>
        </button>
        <button
          className={`nav-item ${tab === "compare" ? "active" : ""}`}
          onClick={() => setTab("compare")}
        >
          <ArrowLeftRight size={17} />
          实验对比
        </button>
        <div className="sidebar-heading">
          实验记录
          <button aria-label="导入实验" onClick={() => setUploadOpen(true)}>
            <Plus size={16} />
          </button>
        </div>
        <div className="search">
          <Search size={15} />
          <input
            placeholder="搜索名称或备注"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="experiment-list">
          {experiments
            .filter((e) =>
              (e.name + " " + e.notes)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((e) => (
              <button
                key={e.id}
                className={`experiment ${selectedId === e.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedId(e.id);
                  setTab("analysis");
                }}
              >
                <div>
                  <span className={`status-dot ${e.status}`} />
                  <strong>{e.name}</strong>
                </div>
                <small>
                  {new Date(e.created_at).toLocaleDateString("zh-CN")}
                  <span>{e.summary?.pairs ?? "—"} 次配对</span>
                </small>
              </button>
            ))}
        </div>
        <div className="sidebar-bottom">
          <span className="live-dot" />
          {serverMode ? "云端数据工作区" : "本地数据工作区"}
          <small>{readyCount} 轮已解析 · v0.1</small>
        </div>
      </aside>
      {tab !== "archive" && (
        <nav className="workbench-actions" aria-label="工作区操作">
          <div className="top-actions">
            <button className="button" onClick={() => setTab("admin")}>
              <Settings2 size={16} />
              管理
            </button>
            <span className="local-badge">
              <span className="live-dot" />
              {serverMode ? "云端运行" : "本地运行"}
            </span>
            <button
              className="button primary"
              onClick={() => setUploadOpen(true)}
            >
              <Plus size={16} />
              导入实验
            </button>
          </div>
        </nav>
      )}
      <main>
        <header className="topbar">
          <div>
            <button
              className="terminal-brand"
              onClick={() => setTab("archive")}
              aria-label="返回实验档案"
            >
              <AudioLines size={25} />
              <span>
                RANGING <b>LAB</b>
                <small>声学实验分析终端</small>
              </span>
            </button>
            <span className="terminal-divider" />
            <button className="archive-back" onClick={() => setTab("archive")}>
              实验档案
            </button>
            <ChevronRight size={13} />
            <span className="current-location">
              {tab === "archive"
                ? "总览"
                : tab === "admin"
                  ? "管理"
                  : tab === "compare"
                    ? "实验对比"
                    : "分析工作台"}
            </span>
          </div>
        </header>
        {tab !== "archive" && (
          <nav className="mobile-workspace" aria-label="移动端工作区">
            <select
              aria-label="选择实验档案"
              value={selectedId}
              onChange={(e) => {
                setSelectedId(e.target.value);
                setTab("analysis");
              }}
            >
              {!experiments.length && <option value="">暂无实验档案</option>}
              {experiments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <button className="button" onClick={() => setTab("compare")}>
              <ArrowLeftRight size={15} />
              对比
            </button>
          </nav>
        )}
        <div className="content">
          {error && (
            <div className="alert error">
              {error}
              <button onClick={() => setError("")} aria-label="关闭错误">
                <X size={15} />
              </button>
            </div>
          )}
          {tab === "archive" ? (
            <Archive
              experiments={experiments}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpen={() => setTab("analysis")}
              onUpload={() => setUploadOpen(true)}
              onManage={() => setTab("admin")}
            />
          ) : tab === "admin" ? (
            <Admin onChanged={refresh} />
          ) : tab === "compare" ? (
            <Compare
              experiments={experiments}
              ids={compared}
              setIds={setCompared}
            />
          ) : !detail ? (
            <div className="empty">
              <div className="empty-icon">
                <AudioLines size={40} />
              </div>
              <h1>{selectedId ? "正在读取实验…" : "让每一次测量都可追溯"}</h1>
              <p>导入 SD 卡采集数据，关联音频、配对事件与时钟状态。</p>
              <button
                className="button primary"
                onClick={() => setUploadOpen(true)}
              >
                <FileUp size={17} />
                导入第一轮实验
              </button>
              <small>A.RNG + B.RNG + COMPLETE.TXT · 单轮最多 64 MiB</small>
            </div>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    RESEARCH FILE /{" "}
                    {String(
                      experiments.findIndex((e) => e.id === selectedId) + 1,
                    ).padStart(3, "0")}{" "}
                    <span>声学测量档案</span>
                  </div>
                  <h1>
                    {detail.name}
                    <span className={`pill ${detail.status}`}>
                      {statusLabel[detail.status]}
                    </span>
                  </h1>
                  <p>
                    {detail.notes ||
                      "为实验添加真实距离与备注，让下一次比较更有依据。"}
                  </p>
                </div>
                <div className="heading-actions">
                  <button className="button" onClick={() => setEditing(true)}>
                    <Settings2 size={15} />
                    实验信息
                  </button>
                  {report && (
                    <a
                      className="button"
                      href={`/api/experiments/${selectedId}/pairs.csv`}
                    >
                      <ArrowDownToLine size={15} />
                      导出 CSV
                    </a>
                  )}
                </div>
              </div>
              {!report ? (
                <div className="empty compact">
                  {detail.status === "failed" ? (
                    <>
                      <h2>这轮数据未完成解析</h2>
                      <p>{detail.error}</p>
                      <button
                        className="button"
                        onClick={() =>
                          request(`/api/experiments/${selectedId}/retry`, {
                            method: "POST",
                          })
                            .then(refresh)
                            .catch((e) => setError(String(e)))
                        }
                      >
                        重新解析
                      </button>
                    </>
                  ) : (
                    <>
                      <LoaderCircle className="spin" size={30} />
                      <h2>{statusLabel[detail.status]}</h2>
                      <p>正在校验原始文件并建立分析索引。</p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  <div className="metrics">
                    <Metric
                      label="记录时长"
                      value={fmt(report.boards.A.duration_s, 1)}
                      unit="s"
                      foot={`${Number(report.boards.A.meta.rate) / 1000} kHz · A / B 双板 · 各 2 通道`}
                      icon={<AudioLines size={17} />}
                    />
                    <Metric
                      label="唯一配对"
                      value={`${stats!.accepted}`}
                      unit={`/ ${stats!.pairs}`}
                      foot={`歧义 ${stats!.ambiguous} · 不一致 ${stats!.rejected}`}
                      icon={<Check size={17} />}
                    />
                    <Metric
                      label="换算距离均值"
                      value={fmt(stats!.mean_mm)}
                      unit="mm"
                      foot={`唯一配对 · 温度 ${fmt(stats!.temperature_c, 1)} °C`}
                      icon={<Activity size={17} />}
                    />
                    <Metric
                      label="换算距离标准差"
                      value={fmt(stats!.std_mm)}
                      unit="mm"
                      foot="总体标准差 · 仅唯一配对"
                      icon={<ArrowLeftRight size={17} />}
                    />
                  </div>
                  {report.warnings.map((w) => (
                    <div className="alert" key={w}>
                      <Info size={16} />
                      {w}
                    </div>
                  ))}
                  {!!detail.duplicate_count && (
                    <div className="alert">
                      <Info size={16} />
                      已有 {detail.duplicate_count}{" "}
                      轮实验使用相同原始文件，本次作为独立记录保存。
                    </div>
                  )}
                  <div className="tabs">
                    <button
                      className={tab === "analysis" ? "active" : ""}
                      onClick={() => setTab("analysis")}
                    >
                      <span className="tab-index">01</span> 信号分析
                    </button>
                    <button
                      className={tab === "health" ? "active" : ""}
                      onClick={() => setTab("health")}
                    >
                      <span className="tab-index">02</span> 采集诊断
                    </button>
                    <button
                      className={tab === "decoded" ? "active" : ""}
                      onClick={() => setTab("decoded")}
                    >
                      <span className="tab-index">03</span> 录音与记录
                    </button>
                    <button
                      className={tab === "ai" ? "active" : ""}
                      onClick={() => setTab("ai")}
                    >
                      <span className="tab-index">04</span> AI 研究报告
                    </button>
                    <div>
                      <Clock3 size={14} />
                      RNG1 · {report.analysis_version}
                    </div>
                  </div>
                  {tab === "health" ? (
                    <Health report={report} />
                  ) : tab === "ai" ? (
                    <AIAnalysis
                      key={selectedId}
                      experimentId={selectedId}
                      metadataVersion={JSON.stringify([
                        detail.name,
                        detail.notes,
                        detail.truth_mm,
                      ])}
                    />
                  ) : tab === "decoded" ? (
                    <DecodedData
                      key={selectedId}
                      experimentId={selectedId}
                      boards={report.boards}
                    />
                  ) : (
                    <>
                      <div className="analysis-grid">
                        <div className="charts">
                          <section className="panel distance-panel">
                            <div className="panel-head">
                              <div>
                                <h2>
                                  <span className="panel-code">R / 02</span>{" "}
                                  配对时差与距离
                                </h2>
                                <p>点击数据点，定位对应的音频片段</p>
                              </div>
                              <button
                                className="text-button"
                                onClick={() => {
                                  setRange(null);
                                  setPairIndex(null);
                                }}
                              >
                                <RotateCcw size={14} />
                                全览
                              </button>
                            </div>
                            <div className="legend">
                              <span>
                                <i style={{ background: "#708b70" }} />
                                唯一配对
                              </span>
                              <span>
                                <i style={{ background: "#b6a04f" }} />
                                歧义候选
                              </span>
                              <span>
                                <i style={{ background: "#b57470" }} />
                                不一致
                              </span>
                            </div>
                            <Chart
                              data={pairTraces}
                              layout={{
                                ...layout,
                                xaxis: {
                                  ...layout.xaxis,
                                  title: { text: "相对主时钟 / s" },
                                  range:
                                    mode === "master"
                                      ? (range ?? [0, report.duration_s])
                                      : [0, report.duration_s],
                                },
                                yaxis: {
                                  title: { text: "换算距离 / mm" },
                                  gridcolor: "#dedfd2",
                                },
                                shapes:
                                  detail.truth_mm != null
                                    ? [
                                        {
                                          type: "line",
                                          xref: "paper",
                                          x0: 0,
                                          x1: 1,
                                          y0: detail.truth_mm,
                                          y1: detail.truth_mm,
                                          line: {
                                            color: "#7ba394",
                                            width: 1,
                                            dash: "dash",
                                          },
                                        },
                                      ]
                                    : [],
                              }}
                              height={230}
                              onClick={(e) => {
                                const index = e.points[0]?.customdata;
                                if (typeof index === "number")
                                  choosePair(index);
                              }}
                              onRange={(r) => {
                                setMode("master");
                                changeRange(r);
                              }}
                            />
                            <div className="panel-foot">
                              <Info size={13} />
                              {report.distance_note}
                            </div>
                          </section>
                          <section className="panel waveform-panel">
                            <div className="panel-head">
                              <div>
                                <h2>
                                  <span className="panel-code">R / 01</span>{" "}
                                  音频波形{" "}
                                  {waveBusy && (
                                    <LoaderCircle size={14} className="spin" />
                                  )}
                                </h2>
                                <p>
                                  {mode === "master"
                                    ? "主时钟关联视图 · 未知时钟区间留空"
                                    : "各板独立录音时间 · 不代表 A/B 同步"}
                                </p>
                              </div>
                              <select
                                aria-label="波形时间基准"
                                value={mode}
                                onChange={(e) => {
                                  setMode(e.target.value);
                                  setRange(null);
                                  setWave(null);
                                }}
                              >
                                <option value="master">主时钟对齐</option>
                                <option value="local">各板录音时间</option>
                              </select>
                            </div>
                            <div className="channel-controls">
                              {["A · CH1", "A · CH2", "B · CH1", "B · CH2"].map(
                                (name, i) => (
                                  <label
                                    key={name}
                                    style={{
                                      color: i < 2 ? colors.A : colors.B,
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={channels[i]}
                                      onChange={() =>
                                        setChannels((old) =>
                                          old.map((v, j) => (i === j ? !v : v)),
                                        )
                                      }
                                    />
                                    {name}
                                  </label>
                                ),
                              )}
                              <label className="event-toggle">
                                <input
                                  type="checkbox"
                                  checked={showEvents}
                                  onChange={(e) =>
                                    setShowEvents(e.target.checked)
                                  }
                                />
                                检出事件
                              </label>
                              <span>点击事件标记放大 · 双击复位</span>
                            </div>
                            {waveError ? (
                              <div className="alert error">{waveError}</div>
                            ) : (
                              <Chart
                                data={[...waveTraces, ...eventPlot.traces]}
                                layout={{
                                  ...layout,
                                  yaxis: {
                                    domain: showEvents ? [0, 0.76] : [0, 1],
                                    title: { text: "PCM 幅值" },
                                    gridcolor: "#dedfd2",
                                  },
                                  yaxis2: {
                                    domain: [0.82, 1],
                                    range: [0, 2],
                                    anchor: "x",
                                    tickvals: [0.5, 1.5],
                                    ticktext: ["B 检出", "A 检出"],
                                    showgrid: false,
                                    zeroline: false,
                                    fixedrange: true,
                                  },
                                  shapes: eventPlot.shapes,
                                }}
                                height={showEvents ? 310 : 250}
                                onRange={changeRange}
                                onClick={(e) => {
                                  const key = e.points[0]?.customdata;
                                  const event = eventPlot.events.find(
                                    (v) => `${v.board}:${v.index}` === key,
                                  );
                                  if (!event) return;
                                  setPairIndex(event.pairIndex);
                                  const peers =
                                    mode === "master" &&
                                    event.pairIndex !== null
                                      ? waveEvents(
                                          report.boards,
                                          report.pairs,
                                          mode,
                                          [0, duration],
                                          [true, true, true, true],
                                          pairIndex,
                                          false,
                                        ).events.filter(
                                          (v) =>
                                            v.pairIndex === event.pairIndex,
                                        )
                                      : [event];
                                  const times = peers.map((v) => v.time);
                                  changeRange([
                                    Math.max(0, Math.min(...times) - 0.01),
                                    Math.min(
                                      duration,
                                      Math.max(...times) + 0.03,
                                    ),
                                  ]);
                                }}
                              />
                            )}
                            {showEvents && (
                              <div className="wave-event-note">
                                {!report.boards.A.event_markers &&
                                  "请重启本地服务以加载检出事件标记。"}
                                A / B
                                两行标记对应各板本地检出事件；悬停查看时间，空心标记表示未锁定。
                                {eventPlot.unpositioned > 0 &&
                                  ` ${eventPlot.unpositioned} 个事件缺少时钟映射，切换“各板录音时间”查看。`}
                              </div>
                            )}
                            {arrivalPair && (
                              <div className="wave-arrival-delta">
                                <strong>
                                  检出时差 B−A：
                                  {fmt(arrivalPair.arrival_delta_us, 3)} μs
                                </strong>
                                <span>
                                  {arrivalPair.arrival_delta_us > 0
                                    ? "A 板先检出"
                                    : arrivalPair.arrival_delta_us < 0
                                      ? "B 板先检出"
                                      : "两板检出时间相同"}{" "}
                                  · 配对记录 #
                                  {String(arrivalPair.index + 1).padStart(
                                    2,
                                    "0",
                                  )}
                                </span>
                                <small>
                                  按两板检出时间戳直接相减；不同于候选组合的最佳配对时差。
                                </small>
                              </div>
                            )}
                            <div className="panel-foot">
                              <Info size={13} />
                              概览保留每段极值，放大加载细节。
                              {mode === "master"
                                ? "B 板事件间插值，事件前 100 ms / 后 160 ms 用时钟模型补齐；未知区间留空。"
                                : ""}
                            </div>
                          </section>
                        </div>
                        <PairDetail
                          pair={pair ?? null}
                          onReset={() => {
                            setPairIndex(null);
                            setRange(null);
                          }}
                        />
                      </div>
                      <section className="panel event-panel">
                        <div className="panel-head">
                          <div>
                            <h2>
                              配对事件记录{" "}
                              <span className="count">
                                {report.pairs.length}
                              </span>
                            </h2>
                            <p>
                              通信序号与本地事件编号分别保留，通过主时钟时间匹配
                            </p>
                          </div>
                          <span className="muted">
                            时间基准 {report.base_master_ns} ns
                          </span>
                        </div>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>事件</th>
                                <th>相对时间 / s</th>
                                <th>A / B 本地事件</th>
                                <th>时差 / μs</th>
                                <th>换算距离 / mm</th>
                                <th>配对状态</th>
                                <th>最佳 / 次佳评分</th>
                              </tr>
                            </thead>
                            <tbody>
                              {report.pairs.map((p) => (
                                <tr
                                  key={p.index}
                                  tabIndex={0}
                                  className={
                                    p.index === pairIndex ? "selected" : ""
                                  }
                                  onClick={() => choosePair(p.index)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") choosePair(p.index);
                                  }}
                                >
                                  <td className="mono">
                                    #{String(p.index + 1).padStart(2, "0")}
                                  </td>
                                  <td className="mono">{fmt(p.time_s, 6)}</td>
                                  <td>
                                    {p.events.A?.event ?? "—"} /{" "}
                                    {p.events.B?.event ?? "—"}
                                  </td>
                                  <td className="mono">{fmt(p.delay_us, 3)}</td>
                                  <td className="mono">
                                    {fmt(p.distance_mm, 3)}
                                  </td>
                                  <td>
                                    <span
                                      className={`pill ${p.outcome === 1 ? "ready" : "warning"}`}
                                    >
                                      {p.reason_label}
                                    </span>
                                  </td>
                                  <td className="mono">
                                    {p.raw.best_score} / {p.raw.runner_score}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {!report.pairs.length && (
                            <p className="empty-table">本轮没有配对日志</p>
                          )}
                        </div>
                      </section>
                    </>
                  )}
                  <footer>
                    原始数据保持不变
                    <span>
                      Ranging Studio ·{" "}
                      {serverMode ? "云端实验分析" : "本地分析预览"}
                    </span>
                  </footer>
                </>
              )}
            </>
          )}
        </div>
      </main>
      {uploadOpen && (
        <Upload
          onClose={() => setUploadOpen(false)}
          onDone={(id) => {
            setSelectedId(id);
            setUploadOpen(false);
            setTab("analysis");
            refresh();
          }}
        />
      )}
      {editing && detail && (
        <Edit
          experiment={detail}
          onClose={() => setEditing(false)}
          onDone={(updated) => {
            setDetail({ ...detail, ...updated });
            setEditing(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  foot,
  icon,
}: {
  label: string;
  value: string;
  unit: string;
  foot: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div>
        {label}
        {icon}
      </div>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
      <p>{foot}</p>
    </div>
  );
}
function PairDetail({
  pair,
  onReset,
}: {
  pair: Pair | null;
  onReset: () => void;
}) {
  return (
    <aside className="panel detail-panel">
      <div className="panel-head">
        <h2>事件详情</h2>
        {pair && (
          <button
            className="icon-button"
            onClick={onReset}
            aria-label="取消事件选择"
          >
            <X size={16} />
          </button>
        )}
      </div>
      {!pair ? (
        <div className="detail-empty">
          <span>
            <Search size={25} />
          </span>
          <h3>从一个异常点开始</h3>
          <p>点击距离曲线或下方事件记录，查看配对评分、候选峰和关联音频。</p>
          <div className="mini-steps">
            <b>01</b> 选择配对事件
            <br />
            <b>02</b> 定位音频片段
            <br />
            <b>03</b> 比较 A / B 候选
          </div>
        </div>
      ) : (
        <div className="detail-body">
          <div className="event-title">
            #{String(pair.index + 1).padStart(2, "0")}
            <span
              className={`pill ${pair.outcome === 1 ? "ready" : "warning"}`}
            >
              {pair.reason_label}
            </span>
          </div>
          <div className="detail-metric">
            {fmt(pair.delay_us, 3)}
            <span>μs · 最佳时差</span>
          </div>
          <dl>
            <dt>次佳时差</dt>
            <dd>{fmt(Number(pair.raw.runner_ns) / 1000, 3)} μs</dd>
            <dt>最佳评分</dt>
            <dd>{pair.raw.best_score}</dd>
            <dt>次佳 / 最佳评分</dt>
            <dd>
              {Number(pair.raw.best_score)
                ? fmt(
                    (Number(pair.raw.runner_score) /
                      Number(pair.raw.best_score)) *
                      100,
                    1,
                  ) + "%"
                : "—"}
            </dd>
            <dt>最佳脉冲跨度</dt>
            <dd>{pair.raw.best_span_ns} ns</dd>
            <dt>通信序号 A / B</dt>
            <dd>
              {pair.raw.event_a_id} / {pair.raw.event_b_id}
            </dd>
          </dl>
          {(["A", "B"] as const).map((b) => (
            <div className="candidate-block" key={b}>
              <h3>
                <span style={{ color: colors[b] }}>●</span> {b} 板候选{" "}
                <small>本地事件 {pair.events[b]?.event ?? "未匹配"}</small>
              </h3>
              {pair.events[b] ? (
                <>
                  <div className="candidate-scroll">
                    <div className="candidate-header">
                      <span>候选</span>
                      <span>脉冲 0 / μs</span>
                      <span>脉冲 1 / μs</span>
                      <span>脉冲 2 / μs</span>
                      <span>质量</span>
                    </div>
                    {pair.events[b]!.candidates.map((c) => (
                      <div
                        className={`candidate ${Number(c.index_zero_based) + 1 === Number(pair.raw[b === "A" ? "best_a" : "best_b"]) ? "best" : ""}`}
                        key={c.index_zero_based}
                      >
                        <span>#{Number(c.index_zero_based) + 1}</span>
                        <span>{fmt(Number(c.pulse0_offset_ns) / 1000, 3)}</span>
                        <span>{fmt(Number(c.pulse1_offset_ns) / 1000, 3)}</span>
                        <span>{fmt(Number(c.pulse2_offset_ns) / 1000, 3)}</span>
                        <span>{c.quality}</span>
                      </div>
                    ))}
                  </div>
                  <p>
                    锁定：{pair.events[b]!.locked === "1" ? "是" : "否"} · epoch{" "}
                    {pair.events[b]!.epoch ?? "不在录音范围"}
                  </p>
                </>
              ) : (
                <p>无法唯一匹配，不推测关联。</p>
              )}
            </div>
          ))}
          <div className="detail-note">
            高亮为固件最佳候选。候选偏移保留各板本地时钟含义；配对日志中的候选编号从
            1 开始。
          </div>
        </div>
      )}
    </aside>
  );
}

function Upload({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]),
    [name, setName] = useState(""),
    [truth, setTruth] = useState(""),
    [notes, setNotes] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function pick(input: File[]) {
    const valid = input.filter((f) =>
      ["A.RNG", "B.RNG", "COMPLETE.TXT"].includes(f.name),
    );
    setFiles(valid);
    if (!name) setName(valid[0]?.webkitRelativePath?.split("/")[0] || "新实验");
    setError(
      valid.length === 3 ? "" : "请选择同一轮的 A.RNG、B.RNG 和 COMPLETE.TXT",
    );
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f, f.name));
      form.append("name", name);
      form.append("truth_mm", truth);
      form.append("notes", notes);
      const result = await request<Experiment>("/api/experiments", {
        method: "POST",
        body: form,
      });
      onDone(result.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">NEW EXPERIMENT</div>
            <h2>导入实验数据</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭导入"
          >
            <X />
          </button>
        </div>
        <label
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            pick(Array.from(e.dataTransfer.files));
          }}
        >
          <FileUp size={31} />
          <strong>
            {files.length
              ? `已选择 ${files.length} 个文件`
              : "拖入采集文件，或点击选择"}
          </strong>
          <span>A.RNG、B.RNG、COMPLETE.TXT · 共不超过 64 MiB</span>
          <input
            type="file"
            multiple
            onChange={(e) => pick(Array.from(e.target.files ?? []))}
          />
        </label>
        <div className="file-chips">
          {files.map((f, i) => (
            <span key={i}>
              <Check size={12} />
              {f.name} · {fmt(f.size / 1048576, 2)} MiB
            </span>
          ))}
        </div>
        <label className="field">
          实验名称
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：50 cm · 室内 · 第一轮"
          />
        </label>
        <label className="field">
          真实距离 / mm <span>可选，用于后续误差比较</span>
          <input
            type="number"
            min="0"
            max="100000"
            step="any"
            value={truth}
            onChange={(e) => setTruth(e.target.value)}
            placeholder="例如 500"
          />
        </label>
        <label className="field">
          实验备注
          <textarea
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="环境、参数、观察到的现象…"
          />
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="modal-footer">
          <span>保留原始数据，自动校验与解析</span>
          <button
            className="button primary"
            disabled={busy || files.length !== 3}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            {busy ? "正在上传…" : "导入并分析"}
          </button>
        </div>
      </form>
    </div>
  );
}
function Edit({
  experiment,
  onClose,
  onDone,
}: {
  experiment: Experiment;
  onClose: () => void;
  onDone: (e: Experiment) => void;
}) {
  const [name, setName] = useState(experiment.name),
    [truth, setTruth] = useState(experiment.truth_mm?.toString() ?? ""),
    [notes, setNotes] = useState(experiment.notes),
    [error, setError] = useState("");
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onDone(
              await request(`/api/experiments/${experiment.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name,
                  notes,
                  truth_mm: truth === "" ? null : Number(truth),
                }),
              }),
            );
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <div className="modal-head">
          <h2>实验信息</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭实验信息"
          >
            <X />
          </button>
        </div>
        <label className="field">
          实验名称
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          真实距离 / mm
          <input
            type="number"
            min="0"
            max="100000"
            step="any"
            value={truth}
            onChange={(e) => setTruth(e.target.value)}
          />
        </label>
        <label className="field">
          备注
          <textarea
            maxLength={4000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        {error && <div className="alert error">{error}</div>}
        <div className="modal-footer">
          <span>原始采集数据不受影响</span>
          <button className="button primary">保存信息</button>
        </div>
      </form>
    </div>
  );
}
function Health({ report }: { report: Report }) {
  return (
    <div className="health-grid">
      {Object.entries(report.boards).map(([b, board]) => (
        <React.Fragment key={b}>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{b} 板 · 同步误差</h2>
                <p>状态快照，使用本板 tick 时间，与主时钟图表不联动</p>
              </div>
            </div>
            <Chart
              data={[
                {
                  type: "scatter",
                  mode: "lines+markers",
                  x: board.status.map((r) => Number(r.tick_ms) / 1000),
                  y: board.status.map((r) => Number(r.sync_error_ns)),
                  line: { color: colors[b as "A" | "B"], width: 1.5 },
                  marker: { size: 4 },
                },
              ]}
              layout={{
                xaxis: {
                  title: { text: "本板 tick / s" },
                  gridcolor: "#dedfd2",
                },
                yaxis: {
                  title: { text: "同步误差 / ns" },
                  gridcolor: "#dedfd2",
                },
              }}
            />
            <div className="health-stats">
              <span>
                日志溢出 <b>{board.meta.log_overflow}</b>
              </span>
              <span>
                音频断点 <b>{board.discontinuities}</b>
              </span>
              <span>
                epoch <b>{board.epochs.join(", ")}</b>
              </span>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{b} 板 · 固件显示距离</h2>
                <p>仅绘制 valid=1 的状态快照，不视为独立单次测距</p>
              </div>
            </div>
            <Chart
              data={[
                {
                  type: "scatter",
                  mode: "lines+markers",
                  x: board.status.map((r) => Number(r.tick_ms) / 1000),
                  y: board.status.map((r) =>
                    r.valid === "1" ? Number(r.distance_mm) : null,
                  ),
                  connectgaps: false,
                  line: { color: colors[b as "A" | "B"], width: 1.5 },
                  marker: { size: 4 },
                },
              ]}
              layout={{
                xaxis: {
                  title: { text: "本板 tick / s" },
                  gridcolor: "#dedfd2",
                },
                yaxis: {
                  title: { text: "固件显示距离 / mm" },
                  gridcolor: "#dedfd2",
                },
              }}
            />
            <div className="health-stats">
              <span>
                audio_drops <b>{board.status.at(-1)?.audio_drops ?? "—"}</b>
              </span>
              <span>
                audio_gaps <b>{board.status.at(-1)?.audio_gaps ?? "—"}</b>
              </span>
              <span>
                audio_overruns{" "}
                <b>{board.status.at(-1)?.audio_overruns ?? "—"}</b>
              </span>
            </div>
          </section>
        </React.Fragment>
      ))}
      <section className="panel full">
        <div className="panel-head">
          <div>
            <h2>时间映射说明</h2>
            <p>{report.alignment.method}</p>
          </div>
        </div>
        <div className="method-note">
          B 板可映射区间共 {report.alignment.b_ranges.length} 段。状态日志只有
          tick_ms，缺少与主时钟一一对应的锚点，因此保留独立时间轴。封存时的时间快照不用于外推整段录音。
        </div>
      </section>
    </div>
  );
}
function Compare({
  experiments,
  ids,
  setIds,
}: {
  experiments: Experiment[];
  ids: string[];
  setIds: (ids: string[]) => void;
}) {
  const [loaded, setLoaded] = useState<Experiment[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setError("");
    Promise.all(
      ids.map((id) =>
        request<Experiment>(`/api/experiments/${id}`, { signal: c.signal }),
      ),
    )
      .then(setLoaded)
      .catch((e) => {
        if (e.name !== "AbortError") setError(String(e));
      });
    return () => c.abort();
  }, [ids]);
  const palette = ["#b76b38", "#3e7377", "#3aa48f", "#d99b44"];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">COMPARE EXPERIMENTS</div>
          <h1>把实验放在一起看</h1>
          <p>最多选择 4 轮实验，比较唯一配对的换算距离分布。</p>
        </div>
      </div>
      <div className="compare-choices">
        {experiments
          .filter((e) => e.status === "ready")
          .map((e) => (
            <label key={e.id} className={ids.includes(e.id) ? "checked" : ""}>
              <input
                type="checkbox"
                checked={ids.includes(e.id)}
                disabled={ids.length >= 4 && !ids.includes(e.id)}
                onChange={() =>
                  setIds(
                    ids.includes(e.id)
                      ? ids.filter((id) => id !== e.id)
                      : [...ids, e.id],
                  )
                }
              />
              {e.name}
            </label>
          ))}
      </div>
      {error && <div className="alert error">{error}</div>}
      {!ids.length ? (
        <div className="empty compact">
          <ArrowLeftRight size={36} />
          <h2>选择需要比较的实验</h2>
          <p>真实距离可在“实验信息”中补充。</p>
        </div>
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>换算距离分布</h2>
              <span className="muted">
                唯一配对 · 按各轮封存温度换算 · 零偏置
              </span>
            </div>
            <Chart
              height={360}
              data={loaded.map((e, i) => ({
                type: "box",
                name: e.name,
                y: e.report?.pairs
                  .filter((p) => p.outcome === 1)
                  .map((p) => p.distance_mm),
                boxpoints: "all",
                jitter: 0.25,
                pointpos: 0,
                marker: { color: palette[i], size: 5 },
                line: { width: 1.5 },
              }))}
              layout={{
                margin: { l: 65, r: 30, t: 25, b: 80 },
                xaxis: { title: { text: "" } },
                yaxis: {
                  title: { text: "换算距离 / mm" },
                  gridcolor: "#dedfd2",
                },
              }}
            />
          </section>
          <section className="panel event-panel">
            <div className="panel-head">
              <h2>统计比较</h2>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>实验</th>
                    <th>唯一配对 / 全部</th>
                    <th>均值 / mm</th>
                    <th>标准差 / mm</th>
                    <th>真实距离 / mm</th>
                    <th>偏差 / mm</th>
                    <th>MAE / mm</th>
                    <th>RMSE / mm</th>
                  </tr>
                </thead>
                <tbody>
                  {loaded.map((e) => {
                    const s = e.report?.stats;
                    const errors =
                      e.truth_mm != null
                        ? e.report?.pairs
                            .filter(
                              (p) => p.outcome === 1 && p.distance_mm != null,
                            )
                            .map((p) => p.distance_mm! - e.truth_mm!)
                        : [];
                    return (
                      <tr key={e.id}>
                        <td>{e.name}</td>
                        <td>
                          {s?.accepted} / {s?.pairs}
                        </td>
                        <td>{fmt(s?.mean_mm)}</td>
                        <td>{fmt(s?.std_mm)}</td>
                        <td>{fmt(e.truth_mm)}</td>
                        <td>
                          {fmt(
                            e.truth_mm != null && s?.mean_mm != null
                              ? s.mean_mm - e.truth_mm
                              : null,
                          )}
                        </td>
                        <td>
                          {fmt(
                            errors?.length
                              ? errors.reduce((a, b) => a + Math.abs(b), 0) /
                                  errors.length
                              : null,
                          )}
                        </td>
                        <td>
                          {fmt(
                            errors?.length
                              ? Math.sqrt(
                                  errors.reduce((a, b) => a + b * b, 0) /
                                    errors.length,
                                )
                              : null,
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="panel-foot">
              <Info size={14} />
              上述指标针对零偏置换算距离，不代表固件最终输出误差；真实距离由用户填写。
            </div>
          </section>
        </>
      )}
    </>
  );
}
