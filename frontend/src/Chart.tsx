import { useEffect, useRef } from "react";
import Plotly from "plotly.js-cartesian-dist-min";
import type {
  Data,
  Layout,
  PlotMouseEvent,
  PlotRelayoutEvent,
} from "plotly.js";

type Props = {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
  onClick?: (event: PlotMouseEvent) => void;
  onRange?: (range: [number, number] | null) => void;
};
export default function Chart({
  data,
  layout = {},
  height = 230,
  onClick,
  onRange,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClick, onRange });
  callbacks.current = { onClick, onRange };
  useEffect(() => {
    const el = ref.current!;
    const observer = new ResizeObserver(() => {
      if (
        !el.isConnected ||
        !el.getClientRects().length ||
        !el.querySelector(".plot-container")
      )
        return;
      // Plotly defers resize internally; navigation can remove the chart meanwhile.
      Promise.resolve(Plotly.Plots.resize(el)).catch((error) => {
        if (el.isConnected && el.getClientRects().length) console.error(error);
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      Plotly.purge(el);
    };
  }, []);
  useEffect(() => {
    const el = ref.current!;
    let disposed = false;
    Plotly.react(
      el,
      data,
      {
        height,
        autosize: true,
        margin: { l: 65, r: 24, t: 12, b: 46 },
        paper_bgcolor: "transparent",
        plot_bgcolor: "#f6f4ef",
        font: {
          family: "Inter, Segoe UI, Microsoft YaHei, sans-serif",
          color: "#687257",
          size: 11,
        },
        showlegend: false,
        hovermode: "closest",
        dragmode: "zoom",
        ...layout,
        xaxis: {
          gridcolor: "#dedfd2",
          zeroline: false,
          title: { text: "相对主时钟 / s" },
          ...layout.xaxis,
        },
        yaxis: {
          gridcolor: "#dedfd2",
          zerolinecolor: "#c6cbb7",
          ...layout.yaxis,
        },
      },
      {
        responsive: true,
        displaylogo: false,
        scrollZoom: false,
        modeBarButtonsToRemove: ["lasso2d", "select2d"],
        toImageButtonOptions: {
          format: "png",
          filename: "ranging-analysis",
          scale: 2,
        },
      },
    ).then((graph) => {
      if (disposed) return;
      graph.removeAllListeners("plotly_click");
      graph.removeAllListeners("plotly_relayout");
      graph.on("plotly_click", (e) => callbacks.current.onClick?.(e));
      graph.on("plotly_relayout", (e: PlotRelayoutEvent) => {
        if (e["xaxis.autorange"]) callbacks.current.onRange?.(null);
        else if (
          e["xaxis.range[0]"] !== undefined &&
          e["xaxis.range[1]"] !== undefined
        )
          callbacks.current.onRange?.([
            Number(e["xaxis.range[0]"]),
            Number(e["xaxis.range[1]"]),
          ]);
      });
    });
    return () => {
      disposed = true;
    };
  }, [data, layout, height]);
  return <div className="plot" style={{ height }} ref={ref} />;
}
