import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";
import {
  archivePosition,
  groupArchives,
  moveArchive,
  moveAllArchives,
  type ArchiveRecord,
} from "./archiveNavigation";
const ArchiveScene = lazy(() => import("./ArchiveScene"));
type Props = {
  experiments: ArchiveRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpen: () => void;
  onUpload: () => void;
  onManage: () => void;
};
const statuses: Record<string, string> = {
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
  onManage,
}: Props) {
  const groups = useMemo(() => groupArchives(experiments), [experiments]);
  const recordNumbers = useMemo(
    () => new Map(experiments.map((record, index) => [record.id, index + 1])),
    [experiments],
  );
  const selected = experiments.find((e) => e.id === selectedId);
  const { column, row } = archivePosition(groups, selectedId);
  const current = groups[column];
  const dialog = useRef<HTMLDialogElement>(null);
  const room = useRef<HTMLElement>(null);
  const wheelState = useRef({ total: 0, lastEvent: 0, lastSwitch: -Infinity });
  const [query, setQuery] = useState("");
  const filtered = experiments.filter((e) =>
    `${e.name} ${e.notes} ${e.created_at}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  function step(axis: "row" | "column", delta: number) {
    const id = moveArchive(groups, selectedId, axis, delta);
    if (id) onSelect(id);
  }
  useEffect(() => {
    const element = room.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      if (
        event.ctrlKey ||
        event.metaKey ||
        dialog.current?.open ||
        document.querySelector(".modal-backdrop") ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],dialog,[role=dialog]",
          ))
      )
        return;
      if (
        !event.deltaY ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
        groups.length === 0
      )
        return;
      event.preventDefault();
      const now = performance.now();
      const state = wheelState.current;
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? window.innerHeight
            : 1);
      if (
        now - state.lastEvent > 180 ||
        Math.sign(delta) !== Math.sign(state.total)
      )
        state.total = 0;
      state.lastEvent = now;
      if (now - state.lastSwitch < 140) {
        state.total = 0;
        return;
      }
      state.total += delta;
      if (Math.abs(state.total) < 18) return;
      const id = moveAllArchives(groups, selectedId, state.total);
      state.total = 0;
      state.lastSwitch = now;
      if (id && id !== selectedId) onSelect(id);
    }
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [groups, selectedId, onSelect]);

  function search() {
    setQuery("");
    dialog.current?.showModal();
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        dialog.current?.open ||
        document.querySelector(".modal-backdrop") ||
        (e.target instanceof HTMLElement &&
          e.target.closest(
            "input,textarea,select,[contenteditable=true],[role=dialog]",
          ))
      )
        return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (
        e.key === "Enter" &&
        e.target instanceof HTMLElement &&
        e.target.closest("button,a")
      )
        return;
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Enter",
          "/",
        ].includes(e.key)
      )
        e.preventDefault();
      if (e.key === "/") search();
      if (e.key === "Enter" && selected) onOpen();
      if (e.key === "ArrowUp") step("row", -1);
      if (e.key === "ArrowDown") step("row", 1);
      if (e.key === "ArrowLeft") step("column", -1);
      if (e.key === "ArrowRight") step("column", 1);
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    <section ref={room} className="archive-room" aria-label="实验档案库">
      <Suspense fallback={<div className="archive-scene scene-loading" />}>
        <ArchiveScene
          groups={groups}
          recordNumbers={recordNumbers}
          selectedId={selectedId}
          onSelect={onSelect}
          onStep={step}
        />
      </Suspense>
      <div className="room-shade" aria-hidden="true" />
      <header className="room-header">
        <div className="room-brand">
          <strong>RANGING LAB</strong>
          <span>ACOUSTIC RESEARCH DIVISION</span>
          <div>
            ANALYSIS <b>OS</b>
          </div>
        </div>
        <nav aria-label="档案操作">
          <button onClick={search}>
            <Search size={18} />
            <span>档案检索</span>
            <kbd>/</kbd>
          </button>
          <button onClick={onUpload}>
            <Plus size={18} />
            <span>导入实验</span>
          </button>
          <button onClick={onManage}>
            <Settings2 size={18} />
            <span>管理</span>
          </button>
        </nav>
      </header>
      <article className="room-record" aria-live="polite">
        <div className="room-eyebrow">
          EXPERIMENT DATABASE <span>/ 实验档案</span>
        </div>
        <h1>
          {selected
            ? `FILE NUMBER: ${String(experiments.indexOf(selected) + 1).padStart(3, "0")}`
            : "ARCHIVE / EMPTY"}
        </h1>
        <div className="room-record-body">
          <div className="room-record-summary">
            <h2>{selected?.name ?? "等待第一份声音档案"}</h2>
            <p>
              {selected
                ? `${selected.created_at.slice(0, 10)} · ${statuses[selected.status] ?? selected.status}`
                : "导入 SD 卡数据，开始探索声音的时间与距离。"}
            </p>
            {selected && (
              <dl>
                <div>
                  <dt>配对事件</dt>
                  <dd>{number(selected.summary?.pairs)}</dd>
                </div>
                <div>
                  <dt>平均距离 / mm</dt>
                  <dd>{number(selected.summary?.mean_mm)}</dd>
                </div>
                <div>
                  <dt>标准差 / mm</dt>
                  <dd>{number(selected.summary?.std_mm)}</dd>
                </div>
              </dl>
            )}
          </div>
          <button
            className="room-access"
            onClick={selected ? onOpen : onUpload}
          >
            <strong>{selected ? "进入分析" : "导入实验"}</strong>
            <span>{selected ? "ACCESS FILE" : "IMPORT DATA"}</span>
            <ArrowRight size={25} />
          </button>
        </div>
      </article>
      <footer className="room-footer">
        <div className="room-counter">
          <span>ARCHIVE / SELECT</span>
          <div>
            {selected ? String(row + 1).padStart(2, "0") : "00"}
            <small>
              / {String(current?.records.length ?? 0).padStart(2, "0")}
            </small>
          </div>
        </div>
        <div className="room-record-nav">
          <button
            aria-label="上一份记录"
            disabled={!experiments.length}
            onClick={() => step("row", -1)}
          >
            <ArrowUp />
          </button>
          <div className="room-ticks">
            {current?.records.map((r, i) => (
              <button
                key={r.id}
                className={r.id === selectedId ? "active" : ""}
                aria-label={`选择记录 ${i + 1}：${r.name}`}
                aria-pressed={r.id === selectedId}
                onClick={() => onSelect(r.id)}
              >
                <i />
              </button>
            ))}
          </div>
          <button
            aria-label="下一份记录"
            disabled={!experiments.length}
            onClick={() => step("row", 1)}
          >
            <ArrowDown />
          </button>
        </div>
        <div className="room-column-nav">
          <button
            aria-label="前一日期列"
            disabled={groups.length < 2}
            onClick={() => step("column", -1)}
          >
            <ArrowLeft />
          </button>
          <div>
            <small>
              COLUMN{" "}
              {groups.length ? String(column + 1).padStart(2, "0") : "00"} /{" "}
              {String(groups.length).padStart(2, "0")}
            </small>
            <span>{current?.date ?? "暂无记录"}</span>
          </div>
          <button
            aria-label="后一日期列"
            disabled={groups.length < 2}
            onClick={() => step("column", 1)}
          >
            <ArrowRight />
          </button>
        </div>
        <div className="room-signature">
          SOUND INTO <b>EVIDENCE.</b>
        </div>
        <div className="room-hint">
          滚轮 循环档案　 /　 ← → 切换日期列　 /　 ↑ ↓ 前后档案　 /　 ENTER 读取
          <span>{experiments.length} 份真实实验 · 空白载体为场景装饰</span>
        </div>
      </footer>
      <dialog
        className="room-search"
        ref={dialog}
        aria-labelledby="archive-search-title"
      >
        <div className="room-search-heading">
          <h2 id="archive-search-title">
            档案检索 <small>ARCHIVE INDEX</small>
          </h2>
          <button aria-label="关闭检索" onClick={() => dialog.current?.close()}>
            <X />
          </button>
        </div>
        <input
          autoFocus
          aria-label="搜索实验"
          placeholder="搜索名称、备注或日期…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p>{filtered.length} 份记录</p>
        <div className="room-results">
          {filtered.map((e) => (
            <button
              key={e.id}
              onClick={() => {
                onSelect(e.id);
                dialog.current?.close();
              }}
            >
              <span>{e.name}</span>
              <small>
                {e.created_at.slice(0, 10)} / {statuses[e.status] ?? e.status}
              </small>
              <ArrowRight size={18} />
            </button>
          ))}
          {!filtered.length && <p>没有匹配的实验。试试其他关键词。</p>}
        </div>
      </dialog>
    </section>
  );
}
