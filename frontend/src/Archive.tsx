import { useState } from "react";
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Plus,
  Search,
} from "lucide-react";

type ArchiveRecord = {
  id: string;
  name: string;
  created_at: string;
  status: string;
  notes: string;
  summary: {
    pairs: number;
    accepted: number;
    mean_mm: number | null;
    std_mm: number | null;
  } | null;
};
type Props = {
  experiments: ArchiveRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: () => void;
  onUpload: () => void;
};
const status: Record<string, string> = {
  ready: "可读取",
  failed: "解析失败",
  queued: "等待解析",
  processing: "解析中",
};
const number = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export default function Archive({
  experiments,
  selectedId,
  onSelect,
  onOpen,
  onUpload,
}: Props) {
  const [query, setQuery] = useState("");
  const selected = experiments.find((e) => e.id === selectedId);
  const index = experiments.findIndex((e) => e.id === selectedId);
  const filtered = experiments.filter((e) =>
    `${e.name} ${e.notes}`.toLowerCase().includes(query.toLowerCase()),
  );
  function step(delta: number) {
    if (!filtered.length) return;
    const current = filtered.findIndex((e) => e.id === selectedId);
    const next =
      current < 0
        ? delta > 0
          ? 0
          : filtered.length - 1
        : (current + delta + filtered.length) % filtered.length;
    onSelect(filtered[next].id);
  }
  return (
    <div className="archive-page">
      <div className="archive-masthead">
        <span>ACOUSTIC RESEARCH DIVISION</span>
        <span>实验数据档案 / ARCHIVE INDEX</span>
        <span>RNG / 01</span>
      </div>
      <section className="archive-hero" aria-label="当前实验档案">
        <div className="archive-intro">
          <div className="archive-kicker">
            <i /> RANGING STUDIO <span>研究档案系统</span>
          </div>
          <h1>
            让声音
            <br />
            留下<span>坐标。</span>
          </h1>
          <p className="archive-description">
            从一次声音，到一组证据。
            <br />
            探索双板采集的波形、时间与距离。
          </p>
          <div className="archive-selection" key={selectedId}>
            <div className="archive-file-label">
              SELECTED RECORD{" "}
              <span>
                {selected
                  ? `NO.${String(index + 1).padStart(3, "0")}`
                  : "NO RECORD"}
              </span>
            </div>
            <h2>{selected?.name ?? "等待第一份实验档案"}</h2>
            <p>
              {selected
                ? `${new Date(selected.created_at).toLocaleDateString("zh-CN")} · ${status[selected.status] ?? selected.status}`
                : "导入 A.RNG、B.RNG 与 COMPLETE.TXT 开始分析。"}
            </p>
            <div className="archive-data">
              <div>
                <span>配对记录</span>
                <strong>
                  {number(selected?.summary?.pairs)}
                  <small>组</small>
                </strong>
              </div>
              <div>
                <span>换算距离均值</span>
                <strong>
                  {number(selected?.summary?.mean_mm)}
                  <small>mm</small>
                </strong>
              </div>
              <div>
                <span>标准差</span>
                <strong>
                  {number(selected?.summary?.std_mm)}
                  <small>mm</small>
                </strong>
              </div>
            </div>
            <button
              className="archive-access"
              onClick={selected ? onOpen : onUpload}
            >
              <span>
                {selected ? "进入实验分析" : "导入实验数据"}
                <small>
                  {selected ? "ACCESS EXPERIMENT" : "IMPORT RECORD"}
                </small>
              </span>
              <ArrowRight size={24} />
            </button>
          </div>
        </div>
        <div className="specimen-stage" aria-hidden="true">
          <div className="stage-coordinate coordinate-top">
            DUAL-BOARD ACOUSTIC CAPTURE <span>01 / 02</span>
          </div>
          <div className="stage-orbit orbit-one" />
          <div className="stage-orbit orbit-two" />
          <div className="specimen-shadow" />
          <div className="specimen-stack">
            <div className="specimen-plate plate-back" />
            <div className="specimen-plate plate-middle" />
            <div className="specimen-plate plate-front">
              <div className="plate-top">
                <span>
                  RANGING
                  <br />
                  <b>ACOUSTICS LAB.</b>
                </span>
                <AudioLines size={25} />
              </div>
              <div className="plate-id">
                {selected
                  ? `NO.${String(index + 1).padStart(3, "0")}`
                  : "NO.000"}
                <small>EXPERIMENT / DATA CARRIER</small>
              </div>
              <div className="receiver receiver-a">
                <span>A</span>
                <i />
                <b />
              </div>
              <div className="receiver receiver-b">
                <span>B</span>
                <i />
                <b />
              </div>
              <svg className="plate-circuit" viewBox="0 0 420 440">
                <path d="M130 195v110q0 40 45 40h90q45 0 45-40V150" />
                <path d="M146 195v102q0 30 33 30h80q33 0 33-30V150" />
              </svg>
              <div className="plate-scan" />
              <div className="plate-bottom">
                <span>
                  48 kHz
                  <br />
                  DUAL CHANNEL
                </span>
                <div className="barcode" />
                <span>RNG1</span>
              </div>
              <i className="plate-screw screw-one" />
              <i className="plate-screw screw-two" />
            </div>
          </div>
          <div className="stage-caption">
            <span>双板声学采集 / 结构示意</span>
            <b>TIME → DISTANCE</b>
          </div>
          <span className="stage-cross cross-one">+</span>
          <span className="stage-cross cross-two">+</span>
        </div>
      </section>
      <section className="archive-catalog" aria-label="实验档案列表">
        <div className="catalog-toolbar">
          <h2>
            <span>01 —</span> 实验档案{" "}
            <small>{String(experiments.length).padStart(2, "0")} RECORDS</small>
          </h2>
          <label className="archive-search">
            <Search size={16} />
            <input
              aria-label="检索实验档案"
              placeholder="检索名称 / 备注"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="archive-pagination">
            <button
              aria-label="上一份档案"
              disabled={!filtered.length}
              onClick={() => step(-1)}
            >
              <ArrowLeft size={18} />
            </button>
            <span>
              {index < 0 ? "00" : String(index + 1).padStart(2, "0")} /{" "}
              {String(experiments.length).padStart(2, "0")}
            </span>
            <button
              aria-label="下一份档案"
              disabled={!filtered.length}
              onClick={() => step(1)}
            >
              <ArrowRight size={18} />
            </button>
          </div>
        </div>
        <div className="archive-records">
          {filtered.map((e) => (
            <button
              key={e.id}
              className={`archive-record ${e.id === selectedId ? "active" : ""}`}
              aria-pressed={e.id === selectedId}
              onClick={() => onSelect(e.id)}
              onDoubleClick={onOpen}
            >
              <div className="record-top">
                <span>
                  R / {String(experiments.indexOf(e) + 1).padStart(3, "0")}
                </span>
                <span className={`record-status ${e.status}`}>
                  {status[e.status] ?? e.status}
                </span>
              </div>
              <h3>{e.name}</h3>
              <div className="record-bottom">
                <span>
                  {e.summary
                    ? `${e.summary.accepted} / ${e.summary.pairs} 唯一配对`
                    : "尚无分析结果"}
                </span>
                <ArrowDownRight size={20} />
              </div>
            </button>
          ))}
          {query && !filtered.length && (
            <p className="archive-no-results">
              没有匹配的档案。试试其他名称或清空检索。
            </p>
          )}
          <button className="archive-import" onClick={onUpload}>
            <Plus size={24} />
            <span>
              导入新实验<small>ADD RECORD</small>
            </span>
          </button>
        </div>
      </section>
      <div className="archive-footer">
        <span>
          <i /> 原始记录 · 可追溯分析
        </span>
        <span>
          RANGING / RESEARCH TERMINAL <b>↗</b>
        </span>
      </div>
    </div>
  );
}
