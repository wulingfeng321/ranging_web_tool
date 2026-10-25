import { useEffect, useState } from "react";
import { LockKeyhole, LogOut, Save, Trash2, RotateCcw, Settings2 } from "lucide-react";

type Config = {
  enabled: boolean; base_url: string; model: string; thinking: string;
  temperature: number; max_tokens: number; timeout_seconds: number;
  has_api_key: boolean; key_from_environment: boolean;
};
type Row = { id: string; name: string; created_at: string; status: string; notes: string; deleted_at: string | null; ai_count: number };

export default function Admin({ onChanged }: { onChanged: () => void }) {
  const [loggedIn, setLoggedIn] = useState(false), [checking, setChecking] = useState(true);
  const [password, setPassword] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [section, setSection] = useState("ai");
  const [config, setConfig] = useState<Config | null>(null), [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false), [rows, setRows] = useState<Row[]>([]), [query, setQuery] = useState("");
  const [trash, setTrash] = useState(false), [confirm, setConfirm] = useState<Row | null>(null), [confirmName, setConfirmName] = useState("");
  async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`/api/admin${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Admin-Action": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) { setLoggedIn(false); setKey(""); setConfig(null); setConfirm(null); }
      throw new Error(typeof data.detail === "string" ? data.detail : "操作失败，请重试。");
    }
    return data;
  }
  async function load() {
    const [settings, experiments] = await Promise.all([api<Config>("/ai"), api<Row[]>("/experiments")]);
    setConfig(settings); setRows(experiments);
  }
  useEffect(() => {
    api<{ authenticated: boolean }>("/session").then(async (session) => {
      setLoggedIn(session.authenticated);
      if (session.authenticated) await load();
    }).catch((e) => setError(e.message)).finally(() => setChecking(false));
  }, []);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  if (checking) return <div className="admin-page"><p>正在检查管理登录状态…</p></div>;
  if (!loggedIn) return <div className="admin-login panel">
    <LockKeyhole size={30} /><h1>网站管理</h1><p>输入管理密码，配置 AI 服务或管理实验数据。</p>
    <form onSubmit={(e) => { e.preventDefault(); action(async () => {
      await api("/login", "POST", { password }); setPassword(""); setLoggedIn(true); await load();
    }); }}>
      <label className="field">管理密码<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} /></label>
      {error && <div className="alert error" role="alert">{error}</div>}
      <button className="button primary" disabled={busy}>{busy ? "正在登录…" : "进入管理页面"}</button>
    </form>
  </div>;
  const visible = rows.filter((row) => Boolean(row.deleted_at) === trash && `${row.name} ${row.notes}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="admin-page">
    <div className="page-heading"><div><div className="eyebrow">ADMINISTRATION</div><h1>网站管理</h1><p>AI 服务设置与实验数据维护</p></div>
      <button className="button" disabled={busy} onClick={() => action(async () => {
        await api("/logout", "POST"); setLoggedIn(false); setConfig(null); setKey(""); setPassword(""); setRows([]); setConfirm(null);
      })}><LogOut size={16} />退出管理</button></div>
    <nav className="admin-tabs" aria-label="管理功能">
      <button className={section === "ai" ? "active" : ""} onClick={() => setSection("ai")}><Settings2 size={17} />AI 配置</button>
      <button className={section === "data" ? "active" : ""} onClick={() => { setSection("data"); action(load); }}><Trash2 size={17} />数据管理</button>
    </nav>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="admin-notice" role="status">{notice}</div>}
    {section === "ai" && config && <form className="panel admin-settings" onSubmit={(e) => { e.preventDefault(); action(async () => {
      const { has_api_key: _has, key_from_environment: _env, ...values } = config;
      const saved = await api<Config>("/ai", "PUT", { ...values, api_key: key, clear_api_key: clearKey });
      setConfig(saved); setKey(""); setClearKey(false); setNotice("AI 配置已保存，下次分析使用新参数。");
    }); }}>
      <h2>AI 服务</h2>
      <label className="admin-toggle"><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />启用 AI 分析</label>
      <p className="admin-help">网站公开访问。启用后，访客可以生成报告并使用你的 API 额度；已有报告始终可查看。</p>
      <div className="admin-form-grid">
        <label className="field">API 基础地址<input type="url" required value={config.base_url} maxLength={500} onChange={(e) => setConfig({ ...config, base_url: e.target.value })} placeholder="https://api.deepseek.com" disabled={config.key_from_environment} /></label>
        <label className="field">模型 ID<input required value={config.model} maxLength={100} onChange={(e) => setConfig({ ...config, model: e.target.value })} /></label>
        <label className="field admin-wide">API Key<input type="password" autoComplete="new-password" value={key} maxLength={4096} disabled={config.key_from_environment || clearKey} onChange={(e) => setKey(e.target.value)} placeholder={config.has_api_key ? "已配置，留空保留原密钥" : "尚未配置，请填写 API Key"} />
          <small>{config.key_from_environment ? "密钥由服务器环境变量管理。" : "密钥仅保存在服务端，不会返回浏览器；更换地址时须重新填写密钥。"}</small></label>
        <label className="admin-toggle admin-wide"><input type="checkbox" checked={clearKey} disabled={config.key_from_environment} onChange={(e) => { setClearKey(e.target.checked); if (e.target.checked) setKey(""); }} />清除已保存的 API Key</label>
        <label className="field">思考模式<select value={config.thinking} onChange={(e) => setConfig({ ...config, thinking: e.target.value })}><option value="disabled">关闭 · 快速汇总</option><option value="enabled">开启 · 深度思考</option></select></label>
        <label className="field">最大输出 Token<input type="number" required min={256} max={32000} step={1} value={config.max_tokens} onChange={(e) => setConfig({ ...config, max_tokens: Number(e.target.value) })} /></label>
        <label className="field">温度（0–2）<input type="number" required min={0} max={2} step={0.1} value={config.temperature} onChange={(e) => setConfig({ ...config, temperature: Number(e.target.value) })} /></label>
        <label className="field">请求超时（秒）<input type="number" required min={10} max={300} step={1} value={config.timeout_seconds} onChange={(e) => setConfig({ ...config, timeout_seconds: Number(e.target.value) })} /></label>
      </div>
      <p className="admin-help">思考模式开启后可适当增加输出上限；模型是否支持这些参数取决于 API 服务。</p>
      <button className="button primary" disabled={busy}><Save size={16} />{busy ? "正在保存…" : "保存 AI 配置"}</button>
    </form>}
    {section === "data" && <section className="panel admin-data">
      <div className="admin-data-tools"><div className="admin-tabs">
        <button className={!trash ? "active" : ""} onClick={() => setTrash(false)}>已上传（{rows.filter(r => !r.deleted_at).length}）</button>
        <button className={trash ? "active" : ""} onClick={() => setTrash(true)}>回收站（{rows.filter(r => r.deleted_at).length}）</button>
      </div><input aria-label="搜索管理中的实验" placeholder="搜索名称或备注" value={query} onChange={(e) => setQuery(e.target.value)} />
      <button className="button" disabled={busy} onClick={() => action(load)}><RotateCcw size={15} />刷新</button></div>
      <p className="admin-help">{trash ? "回收站内的实验可恢复。永久删除将清除原始文件、音频缓存及关联 AI 报告，无法从网页恢复。" : "移入回收站后实验不再公开显示，原始数据和 AI 报告暂时保留；正在解析或生成报告的实验不能删除。"}</p>
      {visible.length === 0 ? <p className="admin-empty">暂无符合条件的实验</p> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>实验</th><th>上传时间</th><th>状态 / AI 记录</th><th>操作</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}>
        <td><strong>{row.name}</strong><small>{row.notes || "暂无备注"}</small></td><td>{new Date(row.created_at).toLocaleString("zh-CN")}</td><td>{({ ready: "已解析", processing: "正在解析", queued: "等待解析", failed: "解析失败" } as Record<string,string>)[row.status] || row.status}<small>{row.ai_count} 条 AI 记录</small></td>
        <td><div className="admin-row-actions">{trash && <button className="button" disabled={busy} onClick={() => action(async () => { await api(`/experiments/${row.id}/restore`, "POST"); await load(); onChanged(); setNotice("实验已恢复。"); })}>恢复</button>}
          <button className="button admin-danger" disabled={busy || ["queued","processing"].includes(row.status)} onClick={() => { setConfirm(row); setConfirmName(""); }}>{trash ? "永久删除" : "移入回收站"}</button></div></td>
      </tr>)}</tbody></table></div>}
    </section>}
    {confirm && <div className="modal-backdrop"><section className="modal admin-confirm" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title">
      <h2 id="admin-confirm-title">{confirm.deleted_at ? "永久删除实验" : "移入回收站"}</h2>
      <p><strong>{confirm.name}</strong></p>
      <p>{confirm.deleted_at ? "将永久删除该实验的原始数据、报告和音频缓存。请输入完整实验名称确认。" : "该实验将从公开页面隐藏，可在管理回收站恢复。"}</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {confirm.deleted_at && <label className="field">确认实验名称<input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" /></label>}
      <div className="modal-footer"><button className="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button>
        <button className="button admin-danger" disabled={busy || Boolean(confirm.deleted_at && confirmName !== confirm.name)} onClick={() => action(async () => {
          const result = await api<{cleanup_pending?: boolean}>(`/experiments/${confirm.id}${confirm.deleted_at ? "/purge" : ""}`, confirm.deleted_at ? "POST" : "DELETE", confirm.deleted_at ? { confirm_name: confirmName } : undefined);
          setConfirm(null); await load(); onChanged(); setNotice(result.cleanup_pending ? "实验记录已删除，残留文件待服务器维护清理。" : confirm.deleted_at ? "实验及关联数据已永久删除。" : "实验已移入回收站。");
        })}>{busy ? "正在处理…" : "确认"}</button></div>
    </section></div>}
  </div>;
}
