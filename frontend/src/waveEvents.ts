import type { Data, Layout } from "plotly.js";

export type EventMarker = {
  index: number;
  event: string;
  local_ns: string;
  local_time_s: number;
  master_time_s: number | null;
  locked: boolean;
};
type EventPair = {
  index: number;
  arrival_delta_us: number;
  events: Record<
    string,
    { event: string; local_ns: string; locked: string } | null
  >;
};
export type VisibleEvent = EventMarker & {
  board: "A" | "B";
  time: number;
  pairIndex: number | null;
  delta: number | null;
};

export function waveEvents(
  boards: Record<string, { event_markers: EventMarker[] }>,
  pairs: EventPair[],
  mode: string,
  range: [number, number],
  channels: boolean[],
  selectedPair: number | null,
  show: boolean,
) {
  const events: VisibleEvent[] = [];
  let unpositioned = 0;
  for (const board of ["A", "B"] as const) {
    if (!channels[board === "A" ? 0 : 2] && !channels[board === "A" ? 1 : 3])
      continue;
    for (const marker of boards[board].event_markers ?? []) {
      const time =
        mode === "master" ? marker.master_time_s : marker.local_time_s;
      if (time === null) {
        unpositioned++;
        continue;
      }
      if (time < range[0] || time > range[1]) continue;
      const matches = pairs.filter(
        (p) =>
          p.events[board]?.event === marker.event &&
          p.events[board]?.local_ns === marker.local_ns,
      );
      const pair = matches.length === 1 ? matches[0] : null;
      const reliable =
        mode === "master" &&
        pair?.events.A?.locked === "1" &&
        pair?.events.B?.locked === "1";
      events.push({
        ...marker,
        board,
        time,
        pairIndex: pair?.index ?? null,
        delta: reliable ? pair.arrival_delta_us : null,
      });
    }
  }
  const traces: Data[] = [];
  const shapes: Partial<Layout["shapes"][number]>[] = [];
  if (show)
    for (const board of ["A", "B"] as const) {
      const rows = events.filter((e) => e.board === board);
      const color = board === "A" ? "#b76b38" : "#3e7377";
      const label = range[1] - range[0] <= 1 || events.length <= 6;
      traces.push({
        type: "scatter",
        mode: label ? "text+markers" : "markers",
        name: `${board} 板检出事件`,
        x: rows.map((e) => e.time),
        y: rows.map(() => (board === "A" ? 1.5 : 0.5)),
        yaxis: "y2",
        customdata: rows.map((e) => `${e.board}:${e.index}`),
        text: rows.map((e) => `${board}${e.event}`),
        textposition: "middle right",
        textfont: { color, size: 11 },
        marker: {
          color,
          size: rows.map((e) =>
            selectedPair !== null && e.pairIndex === selectedPair ? 12 : 9,
          ),
          symbol: rows.map((e) =>
            e.locked ? "triangle-down" : "triangle-down-open",
          ),
          line: { color, width: 1 },
        },
        hovertext: rows.map(
          (e) =>
            `${board} 板 · 本地事件 ${e.event}<br>${mode === "master" ? "相对主时钟" : "本板录音时间"}：${e.time.toFixed(9)} s<br>${e.locked ? "时钟已锁定" : "时钟未锁定，仅表示日志位置"}${e.pairIndex !== null ? `<br>配对记录 #${String(e.pairIndex + 1).padStart(2, "0")}` : "<br>未唯一关联配对记录"}${e.delta !== null ? `<br>检出时差 B−A：${e.delta.toFixed(3)} μs` : mode === "local" ? "<br>两板各自归零，不能直接比较传播时差" : ""}<br>点击放大事件附近`,
        ),
        hovertemplate: "%{hovertext}<extra></extra>",
        cliponaxis: false,
      });
      for (const e of rows)
        shapes.push({
          type: "line",
          xref: "x",
          yref: "paper",
          x0: e.time,
          x1: e.time,
          y0: 0,
          y1: board === "A" ? 0.955 : 0.865,
          line: {
            color,
            width:
              selectedPair !== null && e.pairIndex === selectedPair ? 1.8 : 1,
            dash: board === "A" ? "dot" : "dash",
          },
          opacity:
            selectedPair !== null && e.pairIndex === selectedPair ? 0.85 : 0.32,
          layer: "below",
        });
    }
  return { events, traces, shapes, unpositioned };
}
