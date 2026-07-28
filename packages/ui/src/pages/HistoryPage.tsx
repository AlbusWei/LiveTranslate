import { useEffect, useMemo, useState } from 'react';
import {
  deleteSessionRecord, fetchSegmentAudio, fetchSegments, fetchSessionLog, fetchSessions,
  type SegmentDto, type SessionDto,
} from '../api';
import { createPlayerSink } from '../audio/playerSink';

const MODES = [
  { value: '', label: '全部' },
  { value: 'solo', label: '单人测试' },
  { value: 'filedub', label: '翻译机·配音' },
  { value: 'interpreter', label: '实时翻译机' },
  { value: 'meeting', label: '会议' },
] as const;

const stamp = (ms: number): string => new Date(ms).toLocaleString();

function download(name: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function HistoryPage(): JSX.Element {
  const [mode, setMode] = useState<'' | SessionDto['mode']>('');
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [logText, setLogText] = useState<string | null>(null);
  const sink = useMemo(() => createPlayerSink(), []);

  const reload = (): void => {
    void fetchSessions(mode || undefined).then(setSessions);
  };

  useEffect(reload, [mode]);

  useEffect(() => {
    setLogText(null);
    if (!openId) {
      setSegments([]);
      return;
    }
    void fetchSegments(openId).then(setSegments);
  }, [openId]);

  const visible = sessions.filter((s) => !search || s.id.includes(search) || stamp(s.started_at).includes(search));

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
    if (!window.confirm(`删除会话 ${id}？段落与音频将一并删除（事件日志保留）。`)) return;
    void deleteSessionRecord(id).then(() => {
      if (openId === id) setOpenId(null);
      reload();
    });
  };

  return (
    <div className="history-page">{/* App 外壳已提供 .page-body，不重复套 */}
      <section className="controls">
        {MODES.map((m) => (
          <button key={m.value} className={mode === m.value ? 'active' : ''} onClick={() => setMode(m.value)}>{m.label}</button>
        ))}
        <input placeholder="搜索 session id / 日期" value={search} onChange={(e) => setSearch(e.target.value)} />
      </section>
      <section className="history-list">
        {visible.map((s) => (
          <div key={s.id} className={`history-row ${openId === s.id ? 'open' : ''}`}>
            <button onClick={() => setOpenId(openId === s.id ? null : s.id)}>
              {stamp(s.started_at)} · {MODES.find((m) => m.value === s.mode)?.label} · {s.id}
            </button>
            <button onClick={() => removeSession(s.id)}>删除</button>
          </div>
        ))}
        {visible.length === 0 && <p>暂无历史会话</p>}
      </section>
      {openId && (
        <section className="history-detail">
          <div className="controls">
            <button onClick={exportTxt}>导出双语 TXT</button>
            <button onClick={showLog}>查看事件日志</button>
            {logText !== null && (
              <button onClick={() => download(`${openId}.jsonl`, 'text/plain;charset=utf-8', logText)}>导出日志</button>
            )}
          </div>
          {segments.map((g) => (
            <div key={g.id} className="segment-card status-done">
              <div className="segment-source">
                <span>{g.source_text}</span>
                {g.source_lang && <span className="lang-tag">［{g.source_lang}{g.emotion ? ` · ${g.emotion}` : ''}］</span>}
              </div>
              <div className="segment-target"><span>{g.target_text}</span></div>
              <div className="segment-meta">
                {g.audio_path && (
                  <button onClick={() => void fetchSegmentAudio(g.session_id, g.seq).then((b) => sink.play(b))}>▶ 重播</button>
                )}
              </div>
            </div>
          ))}
          {logText !== null && <pre className="log-view">{logText}</pre>}
        </section>
      )}
    </div>
  );
}
