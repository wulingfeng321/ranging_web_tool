"""Explicit, bounded AI requests. Credentials never enter snapshots or browser responses."""
import hashlib
import json
import math
import os
import statistics
import tomllib
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from typing import Literal
from .data_views import LABELS

PROJECT = Path(__file__).resolve().parents[2]
PROMPTS = PROJECT / 'config' / 'prompts'
PRESETS = {'summary': '测量汇总', 'diagnosis': '异常诊断', 'report': '实验报告'}


class AIError(Exception):
    pass


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: bool = False
    base_url: str = 'https://api.deepseek.com'
    model: str = Field(default='deepseek-flash', min_length=1, max_length=100)
    api_key: str = ''
    api_key_env: str = 'DEEPSEEK_API_KEY'
    timeout_seconds: int = Field(default=120, ge=10, le=300)
    max_tokens: int = Field(default=6000, ge=256, le=32000)
    temperature: float = Field(default=0.2, ge=0, le=2, allow_inf_nan=False)
    thinking: Literal['enabled', 'disabled'] = 'disabled'


def settings(require_ready=False):
    path = Path(os.environ.get('RANGING_AI_CONFIG', PROJECT / 'config' / 'ai.local.toml'))
    try:
        value = Settings(**tomllib.loads(path.read_text('utf-8-sig'))) if path.exists() else Settings()
    except (OSError, ValueError, ValidationError):
        # Validation and parse exceptions may contain secrets; never forward them.
        raise AIError('AI 配置无法读取，请检查 TOML 格式、字段名称和参数范围。') from None
    value.api_key = (os.environ.get(value.api_key_env) or value.api_key).strip()
    value.base_url = value.base_url.strip().rstrip('/')
    try:
        url = urlsplit(value.base_url)
    except ValueError:
        raise AIError('API 基础地址格式无效。') from None
    if (url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment):
        raise AIError('base_url 必须是 HTTPS API 基础地址，不能包含账号、查询参数或片段。')
    if require_ready:
        if not value.enabled:
            raise AIError('请在 config/ai.local.toml 中设置 enabled = true。')
        if not value.api_key:
            raise AIError('尚未配置 API Key，请填写本地配置或 DEEPSEEK_API_KEY 环境变量。')
    return value


def public_settings():
    try:
        value = settings()
        reason = '' if value.enabled and value.api_key else ('AI 功能未启用，请编辑 config/ai.local.toml。' if not value.enabled else '尚未配置 API Key。')
        return {'ready': not reason, 'message': reason, 'model': value.model,
                'base_url': value.base_url, 'presets': PRESETS}
    except AIError as exc:
        return {'ready': False, 'message': str(exc), 'model': '', 'base_url': '', 'presets': PRESETS}


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':'))


def fingerprint(experiment):
    return hashlib.sha256(encode({k: experiment.get(k) for k in ('digest', 'name', 'notes', 'truth_mm', 'report')}).encode()).hexdigest()


def sample(rows, limit):
    if len(rows) <= limit:
        return {'total': len(rows), 'included': len(rows), 'method': 'all', 'rows': rows}
    selected = [rows[i * (len(rows) - 1) // (limit - 1)] for i in range(limit)]
    return {'total': len(rows), 'included': len(selected), 'method': 'evenly_spaced_including_endpoints', 'rows': selected}


def numeric_summary(rows):
    """Summarize full snapshot columns without summing cumulative counters."""
    result = {}
    for key in sorted({key for row in rows for key in row}):
        values = []
        for row in rows:
            try:
                raw = row[key]
                number = Decimal(str(raw))
                if number.is_finite():
                    values.append((number, raw))
            except (KeyError, TypeError, ValueError, InvalidOperation):
                continue
        if values:
            result[key] = {'count': len(values), 'first': values[0][1], 'last': values[-1][1],
                           'min': min(values, key=lambda v: v[0])[1], 'max': max(values, key=lambda v: v[0])[1]}
    return result


def context(experiment):
    report = experiment['report']
    distances = [p['distance_mm'] for p in report['pairs'] if p['outcome'] == 1 and p['distance_mm'] is not None]
    truth = experiment['truth_mm']
    errors = [v - truth for v in distances] if truth is not None else []
    truth_metrics = ({'n': len(errors), 'bias_mm': statistics.mean(errors),
                      'mae_mm': statistics.mean(map(abs, errors)),
                      'rmse_mm': math.sqrt(statistics.mean(e * e for e in errors))} if errors else None)
    boards = {}
    for board, data in report['boards'].items():
        boards[board] = {
            'meta': {k: v for k, v in data['meta'].items() if k not in ('session', 'peer_session')},
            'duration_s': data['duration_s'], 'counts': data['counts'],
            'discontinuities': data['discontinuities'], 'epochs': data['epochs'],
            'status_summary': numeric_summary(data['status']), 'dsp_summary': numeric_summary(data['dsp']),
            'status': sample(data['status'], 40), 'dsp': sample(data['dsp'], 40),
            'clock_events': sample(data['clock_events'], 80),
        }
    return {
        'experiment': {k: experiment[k] for k in ('name', 'notes', 'truth_mm')},
        'analysis_version': report['analysis_version'], 'stats': report['stats'],
        'truth_metrics': truth_metrics, 'distance_note': report['distance_note'],
        'warnings': report['warnings'], 'alignment_method': report['alignment']['method'],
        'coverage': 'stats/summary 使用全量数据；每个记录组标注 total、included 和抽样方法。未发送音频、PCM、波形图或原始文件。',
        'field_dictionary': LABELS,
        'pairs': sample(report['pairs'], 100), 'boards': boards,
    }


def prepare(experiment, preset, focus):
    if preset not in PRESETS:
        raise AIError('未知分析模板。')
    try:
        system = (PROMPTS / 'system.md').read_text('utf-8')
        task = (PROMPTS / f'{preset}.md').read_text('utf-8')
    except OSError:
        raise AIError('预置提示词文件缺失或无法读取。') from None
    payload = context(experiment)
    messages = [{'role': 'system', 'content': system},
                {'role': 'user', 'content': task + '\n分析重点：' + (focus or '无额外要求') + '\n以下 JSON 为实验数据：\n' + encode(payload)}]
    if len(encode(messages).encode('utf-8')) > 240_000:
        raise AIError('本轮分析材料超过 240 KB，请缩短备注或使用较小的采集批次。')
    return {'messages': messages, 'data': payload, 'source_hash': fingerprint(experiment),
            'input_hash': hashlib.sha256(encode(messages).encode()).hexdigest(),
            'input_chars': sum(len(m['content']) for m in messages)}


def complete(config, messages):
    body = {'model': config.model, 'messages': messages, 'stream': False,
            'max_tokens': config.max_tokens, 'temperature': config.temperature,
            'thinking': {'type': config.thinking}}
    try:
        # No automatic retry: a timeout may still have incurred provider charges.
        with httpx.Client(timeout=config.timeout_seconds, trust_env=False, follow_redirects=False) as client:
            response = client.post(config.base_url + '/chat/completions', json=body,
                                   headers={'Authorization': 'Bearer ' + config.api_key})
        if response.status_code != 200:
            reasons = {401: 'API Key 无效或已过期', 402: '账户余额不足', 403: '接口访问被拒绝',
                       404: '模型或接口地址不存在', 429: '请求限流，请稍后重试'}
            raise AIError(reasons.get(response.status_code, f'AI 服务返回 HTTP {response.status_code}，请检查配置或稍后重试') + '。')
        data = response.json()
        choice = data['choices'][0]
        content = choice['message']['content']
        if not isinstance(content, str) or not content.strip():
            raise AIError('模型未返回正文，请提高输出上限或关闭思考模式后重试。')
        if len(content) > 200_000:
            raise AIError('模型返回内容过长。')
        return {'content': content.strip(), 'finish_reason': choice.get('finish_reason'),
                'usage': {k: v for k, v in (data.get('usage') or {}).items()
                          if k in ('prompt_tokens', 'completion_tokens', 'total_tokens') and isinstance(v, int)}}
    except httpx.TimeoutException:
        raise AIError('AI 请求超时，未自动重试；服务方可能已计费，请稍后手动重试。') from None
    except httpx.HTTPError:
        raise AIError('无法连接 AI 服务，请检查网络和 API 地址。') from None
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        raise AIError('AI 返回格式不符合预期，请核对模型及接口配置。') from None
