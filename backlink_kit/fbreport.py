"""fb-report：按日志统计自动填写率、未匹配标签、失败控件、复原成功率。"""
from __future__ import annotations
from collections import Counter, defaultdict
from pathlib import Path

from .fbstores import LogSink


def summarize(entries):
    sources = defaultdict(lambda: {'runs': 0, 'fields': 0, 'filled': 0, 'confirm': 0, 'unmatched': 0,
                                   'honeypot': 0, 'captcha': 0, 'ms': 0, 'sites': set()})
    unmatched = Counter()
    widgets = Counter()
    restores = Counter()
    errors = Counter()
    ai = {'calls': 0, 'fields': 0, 'suggestions': 0, 'cached': 0, 'ms': 0, 'errors': 0}
    for item in entries:
        cat, msg = item.get('cat'), item.get('msg')
        source = item.get('source') or '-'
        if cat == 'perf' and msg == 'run_summary':
            bucket = sources[source]
            bucket['runs'] += 1
            bucket['fields'] += int(item.get('fields_total') or 0)
            bucket['filled'] += int(item.get('filled_auto') or 0)
            bucket['confirm'] += int(item.get('needs_confirm') or 0)
            bucket['unmatched'] += int(item.get('unmatched') or 0)
            bucket['honeypot'] += int(item.get('honeypot') or 0)
            bucket['captcha'] += int(item.get('captcha') or 0)
            bucket['ms'] += int(item.get('ms') or 0)
            if item.get('site'):
                bucket['sites'].add(item['site'])
        elif cat == 'match' and msg == 'unmatched':
            label = (item.get('field') or {}).get('label') or '<无标签>'
            unmatched[label] += 1
        elif cat == 'fill' and msg in ('fill_failed', 'widget_unsupported'):
            widget = (item.get('field') or {}).get('widget') or 'unknown'
            widgets[f'{widget}:{msg}'] += 1
        elif cat == 'restore':
            restores[msg or 'unknown'] += 1
        elif cat == 'ai':
            if msg == 'suggest':
                ai['calls'] += 1
                ai['fields'] += int(item.get('fields') or 0)
                ai['suggestions'] += int(item.get('suggestions') or 0)
                ai['cached'] += int(item.get('cached') or 0)
                ai['ms'] += int(item.get('ms') or 0)
            elif msg in ('error', 'unavailable'):
                ai['errors'] += 1
        elif cat in ('error', 'service'):
            errors[f"{cat}:{str(msg)[:80]}"] += 1
    rows = []
    for source, bucket in sorted(sources.items(), key=lambda kv: -kv[1]['runs']):
        total = bucket['fields'] or 1
        rows.append({'source': source, 'runs': bucket['runs'], 'fields': bucket['fields'],
                     'filled_auto': bucket['filled'], 'needs_confirm': bucket['confirm'],
                     'unmatched': bucket['unmatched'], 'honeypot': bucket['honeypot'],
                     'captcha': bucket['captcha'],
                     'fill_rate': round(bucket['filled'] / total, 3),
                     'avg_ms': round(bucket['ms'] / max(1, bucket['runs'])),
                     'sites': ','.join(sorted(bucket['sites']))})
    restore_total = sum(restores.values()) or 1
    return {'sources': rows,
            'unmatched_labels': [{'label': label, 'count': count} for label, count in unmatched.most_common(50)],
            'failed_widgets': [{'widget': widget, 'count': count} for widget, count in widgets.most_common(30)],
            'restores': dict(restores),
            'restore_success_rate': round(sum(v for k, v in restores.items() if k in ('restored', 'restored_partial')) / restore_total, 3),
            'ai': ai,
            'errors': [{'error': msg, 'count': count} for msg, count in errors.most_common(20)]}


def render_markdown(report, days, log_root):
    lines = [f'# Fast-Backlink 周报（最近 {days} 天）', '',
             f'日志目录：`{log_root}`', '', '## 各来源自动填写率', '',
             '| 来源 | 站点 | 轮次 | 字段 | 自动填 | 待确认 | 未匹配 | 蜜罐 | 验证码 | 填写率 | 平均耗时(ms) |',
             '|---|---|---|---|---|---|---|---|---|---|---|']
    for row in report['sources']:
        lines.append('| {source} | {sites} | {runs} | {fields} | {filled_auto} | {needs_confirm} | {unmatched} | {honeypot} | {captcha} | {fill_rate:.0%} | {avg_ms} |'.format(**row))
    if not report['sources']:
        lines.append('| - | - | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0% | 0 |')
    lines += ['', '## 未匹配标签排行（下一轮补同义词/补素材的依据）', '']
    lines += [f'- {item["count"]}× {item["label"]}' for item in report['unmatched_labels']] or ['- 无']
    lines += ['', '## 失败控件类型排行', '']
    lines += [f'- {item["count"]}× {item["widget"]}' for item in report['failed_widgets']] or ['- 无']
    lines += ['', '## 复原', '']
    lines.append(f'- 成功率 {report["restore_success_rate"]:.0%}；明细 {report["restores"] or "无"}')
    ai = {'calls': 0, 'fields': 0, 'suggestions': 0, 'cached': 0, 'ms': 0, 'errors': 0, **(report.get('ai') or {})}
    lines += ['', '## AI 兜底', '']
    lines.append('- 调用 {calls} 次；输入字段 {fields}；建议 {suggestions}；缓存命中 {cached}；平均 {avg}ms；错误 {errors}'.format(
        avg=round((ai.get('ms') or 0) / max(1, ai.get('calls') or 0)), **ai))
    lines += ['', '## 错误排行', '']
    lines += [f'- {item["count"]}× {item["error"]}' for item in report['errors']] or ['- 无']
    lines.append('')
    return '\n'.join(lines)


def build(log_root, days=7):
    sink = LogSink(log_root)
    entries = sink.read(days=days, limit=200000)
    return summarize(entries), len(entries)


def write(log_root, days=7, output=None):
    report, count = build(log_root, days)
    output = Path(output) if output else Path(log_root) / 'report.md'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_markdown(report, days, log_root), encoding='utf-8')
    return report, output, count
