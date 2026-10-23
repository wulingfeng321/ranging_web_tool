import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Config = {
  ready: boolean;
  message: string;
  model: string;
  base_url: string;
  presets: Record<string, string>;
};
type Snapshot = {
  input_hash: string;
  input_chars: number;
  messages: { role: string; content: string }[];
  data: unknown;
};
type Run = {
  id: string;
  created_at: string;
  status: string;
  preset: string;
  focus: string;
  model: string;
  base_url: string;
  stale: boolean;
  error: string | null;
  result: {
    content: string;
    finish_reason: string;
    usage: Record<string, number>;
  } | null;
};
async function api<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(
    url,
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
  const value = await r.json();
  if (!r.ok)
    throw new Error(
      typeof value.detail === "string"
        ? value.detail
        : "请求失败，请检查本地服务。",
    );
  return value;
}
function save(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AIAnalysis({
  experimentId,
  metadataVersion,
}: {
  experimentId: string;
  metadataVersion: string;
}) {
  const base = `/api/experiments/${experimentId}/ai`;
  const [config, setConfig] = useState<Config | null>(null),
    [preset, setPreset] = useState("summary"),
    [focus, setFocus] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [previewBusy, setPreviewBusy] = useState(true);
  const [runs, setRuns] = useState<Run[]>([]),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [previewError, setPreviewError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<Config>("/api/ai/config", undefined, controller.signal)
      .then(setConfig)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setPreviewBusy(true);
    setPreviewError("");
    const timer = setTimeout(() => {
      api<Snapshot>(`${base}/preview`, { preset, focus }, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setSnapshot(value);
        })
        .catch((e) => {
          if (e.name !== "AbortError") setPreviewError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [base, preset, focus, metadataVersion, revision]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const rows = await api<Run[]>(
          `${base}/runs`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setRuns(rows);
        setSelected((old) =>
          rows.some((r) => r.id === old) ? old : (rows[0]?.id ?? ""),
        );
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    }
    poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, revision]);
  const active = runs.some((r) => r.status === "running");
  const run = runs.find((r) => r.id === selected);
  async function generate() {
    if (!snapshot || busy || active) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<{ id: string }>(`${base}/runs`, {
        preset,
        focus,
        input_hash: snapshot.input_hash,
      });
      setSelected(value.id);
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function downloadSnapshot() {
    if (!run) return;
    try {
      save(
        `ai-${run.id}-input.json`,
        JSON.stringify(await api(`${base}/runs/${run.id}/snapshot`), null, 2),
        "application/json",
      );
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div className="ai-page">
      <section className="panel ai-compose">
        <div className="panel-head">
          <div>
            <h2>
              <Sparkles size={19} /> AI 测量分析
            </h2>
            <p>结合配对结果、测量统计和采集状态，生成有数据依据的实验总结。</p>
          </div>
          <span className="section-tag">{config?.model || "DeepSeek"}</span>
        </div>
        <div className="ai-config-line">
          <span className={`pill ${config?.ready ? "ready" : "warning"}`}>
            {config?.ready ? "已配置" : "待配置"}
          </span>
          <span>
            {config?.ready
              ? `分析服务：${config.base_url}`
              : config?.message || "正在读取配置…"}
          </span>
          <button
            className="text-button"
            onClick={() => {
              setError("");
              setRevision((n) => n + 1);
            }}
          >
            <RefreshCw size={14} />
            刷新配置
          </button>
        </div>
        {!config?.ready && (
          <div className="ai-setup">
            打开项目中的 <code>config/ai.local.toml</code>，填写{" "}
            <code>api_key</code> 并将 <code>enabled</code> 改为{" "}
            <code>true</code>，保存后刷新配置即可。密钥仅由后端读取。
          </div>
        )}
        <div className="ai-presets" aria-label="分析方式">
          {Object.entries(
            config?.presets ?? {
              summary: "测量汇总",
              diagnosis: "异常诊断",
              report: "实验报告",
            },
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={preset === key}
              className={preset === key ? "active" : ""}
              onClick={() => {
                setSnapshot(null);
                setPreset(key);
              }}
            >
              <FileText size={17} />
              {label}
              <small>
                {key === "summary"
                  ? "稳定性与误差概览"
                  : key === "diagnosis"
                    ? "异常证据与验证建议"
                    : "整理可留存的实验记录"}
              </small>
            </button>
          ))}
        </div>
        <label className="ai-focus">
          补充分析重点（可选）
          <textarea
            aria-label="补充分析重点"
            rows={3}
            maxLength={2000}
            value={focus}
            onChange={(e) => {
              setSnapshot(null);
              setFocus(e.target.value);
            }}
            placeholder="例如：重点检查 B 板时钟锁定是否影响配对，区分系统偏差与随机波动。"
          />
        </label>
        <div className="ai-scope">
          <strong>本次发送范围</strong>
          <p>
            实验名称与备注、真实距离（如已填写）、测量统计、配对及候选记录、两板时钟和采集状态。大批量记录会抽样并标明覆盖范围；原始音频和逐帧
            PCM 不发送。
          </p>
          <p>
            点击生成后，上述内容和提示词将发送至配置的 API
            服务并产生相应调用费用。结果作为辅助分析，仍需结合原始数据复核。
          </p>
        </div>
        {previewError && (
          <div className="alert error" role="alert">
            {previewError}
          </div>
        )}
        <details className="ai-preview">
          <summary>
            查看待发送的数据与提示词{" "}
            {snapshot
              ? `· ${snapshot.input_chars.toLocaleString()} 字符`
              : previewBusy
                ? "· 正在整理"
                : ""}
          </summary>
          {snapshot && (
            <>
              <button
                className="text-button"
                onClick={() =>
                  save(
                    "ai-analysis-input.json",
                    JSON.stringify(snapshot, null, 2),
                    "application/json",
                  )
                }
              >
                <ArrowDownToLine size={15} />
                下载分析材料
              </button>
              <pre>
                {snapshot.messages
                  .map(
                    (m) =>
                      `【${m.role === "system" ? "数据说明与分析规则" : "分析任务与实验数据"}】\n${m.content}`,
                  )
                  .join("\n\n")}
              </pre>
            </>
          )}
        </details>
        <div className="ai-submit">
          <span>
            {active
              ? "分析正在后台运行，可切换页面，稍后查看结果。"
              : "仅在点击生成时调用 API，刷新页面不会重复调用。"}
          </span>
          <button
            className="button primary"
            disabled={
              !config?.ready || !snapshot || previewBusy || busy || active
            }
            onClick={generate}
          >
            {busy || active ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Sparkles size={17} />
            )}{" "}
            {active ? "正在分析…" : "生成分析报告"}
          </button>
        </div>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
      </section>
      <section className="panel ai-results">
        <div className="panel-head">
          <div>
            <h2>分析报告</h2>
            <p>展示最近 30 次记录；历史报告对应当时的数据与提示词。</p>
          </div>
          {runs.length > 0 && (
            <select
              aria-label="历史分析报告"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.created_at).toLocaleString("zh-CN")} ·{" "}
                  {config?.presets[r.preset] ?? r.preset} ·{" "}
                  {r.status === "running"
                    ? "进行中"
                    : r.status === "failed"
                      ? "失败"
                      : "已完成"}
                </option>
              ))}
            </select>
          )}
        </div>
        {!run ? (
          <div className="data-placeholder">
            <Sparkles size={25} />
            选择分析方式，生成本轮实验的第一份报告。
          </div>
        ) : (
          <div className="ai-result-body">
            <div className="ai-report-meta">
              <span>
                {run.model} · {new Date(run.created_at).toLocaleString("zh-CN")}
              </span>
              <button className="text-button" onClick={downloadSnapshot}>
                下载本次输入快照
              </button>
              {run.result && (
                <button
                  className="button"
                  onClick={() =>
                    save(
                      `analysis-${run.id}.md`,
                      `# ${config?.presets[run.preset] ?? "实验分析"}\n\n生成时间：${run.created_at}\n模型：${run.model}\n\n${run.result?.finish_reason === "length" ? "注意：输出达到上限，内容可能不完整。\n\n" : ""}${run.result?.content}`,
                      "text/markdown;charset=utf-8",
                    )
                  }
                >
                  <ArrowDownToLine size={15} />
                  导出 Markdown
                </button>
              )}
            </div>
            {run.stale && (
              <div className="alert">
                实验信息或数据已更新，这份报告基于旧版本，请重新生成以分析当前数据。
              </div>
            )}
            {run.focus && (
              <p className="ai-report-focus">分析重点：{run.focus}</p>
            )}
            {run.status === "running" && (
              <div className="data-placeholder">
                <LoaderCircle className="spin" />
                正在生成，请稍候。完成后将自动显示。
              </div>
            )}
            {run.error && (
              <div className="alert error" role="alert">
                {run.error} 可在上方手动重新生成。
              </div>
            )}
            {run.result && (
              <>
                {run.result.finish_reason === "length" && (
                  <div className="alert">
                    输出达到上限，报告可能不完整。可提高配置中的 max_tokens
                    后重新生成。
                  </div>
                )}
                <article className="ai-markdown">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      a: ({ children }) => <span>{children}</span>,
                      img: () => null,
                    }}
                  >
                    {run.result.content}
                  </Markdown>
                </article>
                <p className="ai-usage">
                  输入 {run.result.usage.prompt_tokens ?? "—"} tokens · 输出{" "}
                  {run.result.usage.completion_tokens ?? "—"} tokens · AI
                  生成内容，请结合数据复核。
                </p>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
