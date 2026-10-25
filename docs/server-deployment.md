# 腾讯云部署与维护

部署日期：2026-10-25。Ubuntu 24.04 / Python 3.12.3，2 核 / 2 GiB。

## 访问

- 网站：https://ranging.wulingfeng.top
- 服务器：43.142.15.59，SSH 用户 ubuntu，端口 22。
- 按用户要求于 2026-10-25 取消网站登录限制，用于约半个月的课程展示。网站无需用户名或密码，旧访问凭据不再使用。
- Nginx 通过 HTTPS 公开提供应用；HTTP 跳转 HTTPS。后端仅监听 127.0.0.1:8000。
- 这是公开共享的实验工作区，访问者可以查看、上传、编辑同一批实验；没有多用户数据隔离。课程结束后由用户通知关闭，本次没有设置自动关闭任务。
- 域名解析和证书签发均已成功；当前计算机的 DNS 负缓存已自然刷新。如其他设备暂时打不开新域名，可等待缓存刷新后重试。

## 目录

| 用途 | 服务器路径 |
| --- | --- |
| 初始发布 | `/opt/ranging-studio/releases/20261025-initial` |
| 当前发布软链接 | `/opt/ranging-studio/current` |
| 数据库、原始文件、报告和音频缓存 | `/var/lib/ranging-studio` |
| AI 配置 | `/etc/ranging-studio/ai.local.toml` |
| 旧网站密码哈希（不再启用） | `/etc/nginx/ranging-studio.htpasswd` |
| Nginx 网站配置 | `/etc/nginx/sites-available/ranging-studio` |
| 系统服务 | `/etc/systemd/system/ranging-studio.service` |
| 数据备份 | `/var/backups/ranging-studio` |

程序使用独立的 ranging 系统用户，无登录权限；代码和配置由 root 持有，服务只可写数据目录。保持单个后端进程，避免多个进程重复管理后台任务。

## 日常操作（SSH 登录服务器后）

```bash
sudo systemctl status ranging-studio --no-pager
sudo journalctl -u ranging-studio -n 100 --no-pager
sudo systemctl restart ranging-studio
sudo nginx -t
```

重启前请等待解析和 AI 任务结束；中断的任务会标记为失败，需要手动重试。

网站现为公开访问，不需要维护登录密码。旧密码文件保留用于配置回退，当前 Nginx 配置不引用它。

## HTTPS

使用 Let's Encrypt，首张证书到期日为 2027-01-23。`certbot.timer` 已启用，续期成功后自动检查并重载 Nginx。已通过模拟续期和重载钩子验证。

```bash
systemctl list-timers certbot.timer
sudo certbot renew --dry-run --run-deploy-hooks
```

保留域名 A 记录指向服务器，并保持 80 / 443 端口可访问，以便证书续期。8000 不对公网监听。

## AI 配置

已迁移历史 AI 报告，没有迁移本地 API Key；服务器默认关闭新的 AI 请求。若需启用，在服务器编辑配置：

```bash
sudo nano /etc/ranging-studio/ai.local.toml
```

设置 `enabled = true` 并填写 `api_key`，保存后下次请求自动生效。不要把密钥写入 Git 或聊天。当前网站公开，启用后访问者可提交 AI 分析并消耗该 Key 的额度。

## 备份与恢复

手动备份（服务会短暂停止，完成后恢复）：

```bash
sudo bash /opt/ranging-studio/current/deploy/backup.sh
```

备份包含 SQLite、原始文件、报告、AI 配置、密码哈希、Nginx 和服务配置，以及当前发布软链接。备份权限仅 root 可读；代码发布目录需另行保留。已执行首次备份并检查归档可读取；尚未安排自动每日数据备份，也未演练完整灾难恢复。应定期下载备份到其他设备，避免服务器磁盘损坏同时丢失原件和备份。

恢复时先停止服务，将备份解压到单独的检查目录，核对 SQLite 完整性和数据后再替换数据目录；不要在运行中覆盖数据库。跨版本恢复应同时切回对应的代码发布目录，并检查配置和目录权限。

## 后续发布

1. Windows 完成修改、测试并提交 Git。运行 `npm.cmd run build`（frontend 目录）。
2. 在项目根目录运行 `backend/.venv/Scripts/python.exe scripts/package_release.py`。只打包 Git 跟踪的后端、部署配置、示例配置、提示词和前端构建；排除本地数据、密钥、node_modules 和 Windows 虚拟环境。
3. 上传 `artifacts/ranging-release.tar.gz`，解压到新的 `/opt/ranging-studio/releases/<版本>`，使用 Linux Python 创建该版本自己的 `backend/.venv` 并安装固定依赖。
4. 先执行 Linux 后端测试，备份数据，再停止服务、切换 current 软链接、启动服务。检查健康接口、公开访问、波形与音频。不要自动覆盖 `/etc/ranging-studio` 或数据目录。
5. 如需回退，停止服务并将 current 切回前一发布目录，再启动服务。未来涉及数据库结构变更时，需要另行验证数据兼容性。

## 本次数据迁移

通过 SQLite 在线备份生成一致的快照，确认没有运行中的解析/AI任务，并检查复制前后实验记录没有变化。已迁移 10 轮实验、4 条 AI 记录、50 个数据文件；全部 SHA-256 核对一致。迁移包约 60 MB，解压数据约 90 MB。服务器空数据库在替换前另行保存，本地原件未修改。

本地和云端从此是两个独立工作区，不自动同步后续新增记录。`scripts/package_data.py` 可生成新的迁移快照，但不能直接覆盖已有云端实验；后续合并需按实验 ID 检查冲突。

## 验证范围

- Linux 后端 40 项测试通过；前端 4 项测试及生产构建通过。
- 初次部署曾验证密码认证；按用户要求取消后，验证 HTTPS 页面和实验接口无需凭据即可访问。
- 10 轮报告和事件标记正常；两种时间模式、双板 WAV 范围请求、CSV、解析数据接口验证通过。
- 浏览器通过 SSH 隧道连接同一云端后端检查真实迁移数据；公网 HTTPS 和认证另行通过外部请求验证。截图不代表通过公开 HTTP 暴露后端。
- 证书模拟续期成功；服务开机启动已启用，未为验证而重启整台服务器。
- 本轮未调用真实 AI 接口，不产生模型调用费用。

截图：[云端实验工作区](screenshots/cloud-deployment-2026-10-25.png)。
