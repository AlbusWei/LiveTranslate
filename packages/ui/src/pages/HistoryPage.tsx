import { useEffect, useMemo, useState } from 'react';
import { Mic, AudioLines, Users, Search, ChevronDown, Play, Trash2, FileText } from 'lucide-react';
import {
  deleteSessionRecord, fetchSegmentAudio, fetchSegments, fetchSessionLog, fetchSessions,
  type SegmentDto, type SessionDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';

const MODES = [
  { value: '', label: '全部' },
  { value: 'solo', label: '实时' },
  { value: 'interpreter', label: '实时' },
  { value: 'filedub', label: '配音' },
  { value: 'meeting', label: '会议' },
] as const;

const FILTER_CHIPS = [
  { value: '', label: '全部' },
  { value: 'live', label: '实时' },
  { value: 'filedub', label: '配音' },
  { value: 'meeting', label: '会议' },
] as const;

const MODE_ICON: Record<string, { icon: typeof Mic; bg: string; color: string }> = {
  solo: { icon: Mic, bg: 'var(--color-primary-soft)', color: 'var(--color-primary)' },
  interpreter: { icon: Mic, bg: 'var(--color-primary-soft)', color: 'var(--color-primary)' },
  filedub: { icon: AudioLines, bg: 'var(--color-success-soft)', color: 'var(--color-success)' },
  meeting: { icon: Users, bg: '#F0E8FE', color: '#7C5BD4' },
};

function dateGroup(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = today.getTime() - target.getTime();
  if (diff === 0) return '今天';
  if (diff === 86400000) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function download(name: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export function HistoryPage(): JSX.Element {
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [logText, setLogText] = useState<string | null>(null);
  const sink = useMemo(() => createPlayerSink(), []);

  const modeFilter = filter === 'live' ? undefined : filter || undefined;

  const reload = (): void => {
    void fetchSessions(modeFilter as SessionDto['mode'] | undefined).then(setSessions);
  };

  useEffect(reload, [filter]);

  useEffect(() => {
    setLogText(null);
    if (!openId) { setSegments([]); return; }
    void fetchSegments(openId).then(setSegments);
  }, [openId]);

  const visible = sessions.filter((s) => !search || s.id.includes(search) || new Date(s.started_at).toLocaleString().includes(search));

  // Group by date
  const groups: { label: string; items: SessionDto[] }[] = [];
  for (const s of visible) {
    const label = dateGroup(s.started_at);
    const g = groups.find((x) => x.label === label);
    if (g) g.items.push(s);
    else groups.push({ label, items: [s] });
  }

  const exportTxt = (): void => {
    if (!openId) return;
    const lines = segments.map((g) => `[${g.seq}] ${g.source_text}\n    ${g.target_text}`);
    download(`${openId}.txt`, 'text/plain;charset=utf-8', lines.join('\n\n') + '\n');
  };

  const showLog = (): void => {
    if (!openId) return;
    void fetchSessionLog(openId).then((t) => setLogText(t ?? '（未找到该 session 的事件日志文件）'));
  };

  const removeSession = (id: string): void => {
    if (!window.confirm(`删除会话 ${id}？段落与音频将一并删除。`)) return;
    void deleteSessionRecord(id).then(() => { if (openId === id) setOpenId(null); reload(); });
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">历史</h1>
        <p className="page-subtitle">你的每一次翻译都被妥善保管</p>
      </div>

      <div className="history-filter">
        {FILTER_CHIPS.map((c) => (
          <button key={c.value} className={`chip${filter === c.value ? ' active' : ''}`} onClick={() => setFilter(c.value)}>{c.label}</button>
        ))}
        <div className="history-search">
          <Search size={14} />
          <input className="input" placeholder="搜索翻译记录…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {groups.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon"><FileText size={24} /></div>
          <div className="empty-title">还没有翻译记录</div>
          <div className="empty-desc">开始第一次翻译后，记录将出现在这里</div>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.label}>
          <div className="date-group-title">{group.label}</div>
          {group.items.map((s) => {
            const modeInfo = MODE_ICON[s.mode] ?? MODE_ICON['solo']!;
            const ModeIcon = modeInfo.icon;
            const isOpen = openId === s.id;
            const time = new Date(s.started_at);
            const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
            return (
              <div key={s.id} className={`card session-card${isOpen ? ' expanded' : ''}`}>
                <button className="session-card-header" onClick={() => setOpenId(isOpen ? null : s.id)}>
                  <div className="session-mode-icon" style={{ background: modeInfo.bg, color: modeInfo.color }}>
                    <ModeIcon size={18} />
                  </div>
                  <div className="session-info">
                    <div className="session-title">{s.id.slice(0, 12)}… · {s.mode}</div>
                    <div className="session-meta">{timeStr}</div>
                  </div>
                  <div className="session-badges">
                    <span className="session-expand-icon"><ChevronDown size={16} /></span>
                  </div>
                </button>
                <div className="session-detail">
                  {segments.map((g) => (
                    <div key={g.id} className="session-detail-seg">
                      <div className="session-detail-target">{g.target_text}</div>
                      <div className="session-detail-source">
                        {g.source_text}
                        {g.source_lang && <span className="emotion-badge" style={{ marginLeft: '6px' }}>{g.source_lang}</span>}
                      </div>
                      {g.audio_path && (
                        <button className="segment-replay" style={{ marginTop: '4px' }} onClick={() => void fetchSegmentAudio(g.session_id, g.seq).then((b) => sink.play(b))}>
                          <Play size={12} />重播
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="session-detail-actions">
                    <button className="btn btn-secondary btn-sm" onClick={exportTxt}>导出双语 TXT</button>
                    <button className="btn btn-ghost btn-sm" onClick={showLog}>查看事件日志</button>
                    {logText !== null && <button className="btn btn-secondary btn-sm" onClick={() => download(`${s.id}.jsonl`, 'text/plain;charset=utf-8', logText)}>导出日志</button>}
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => removeSession(s.id)}><Trash2 size={13} />删除</button>
                  </div>
                  {logText !== null && <pre style={{ maxHeight: '240px', overflow: 'auto', background: 'var(--color-bg)', padding: '12px', borderRadius: 'var(--radius-md)', fontSize: '11px', marginTop: 'var(--space-3)' }}>{logText}</pre>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
