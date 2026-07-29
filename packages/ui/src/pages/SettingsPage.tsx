import { useEffect, useMemo, useReducer, useState } from 'react';
import { LANGUAGES } from '@livetranslate/core';
import { ChevronDown, Plus, Trash2, Pencil } from 'lucide-react';
import { createGatewayApi } from '../api';
import type { HotwordTableDto } from '../api';
import { SettingsUiStore } from '../state/settingsStore';

export function SettingsPage(): JSX.Element {
  const store = useMemo(() => new SettingsUiStore(createGatewayApi()), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [keyDraft, setKeyDraft] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [hostDraft, setHostDraft] = useState('');
  const [editingHost, setEditingHost] = useState(false);
  const [tableDraft, setTableDraft] = useState('');
  const [advOpen, setAdvOpen] = useState(false);

  useEffect(() => {
    const off = store.subscribe(force);
    void store.load().then(() => setHostDraft(store.state.settings.workspaceHost));
    return off;
  }, [store]);

  const { settings, maskedKey, hasKey, selfCheck, busy, lastError } = store.state;

  return (
    <div className="page-content">
      <div className="page-header">
        <h1 className="page-title">设置</h1>
      </div>
      {lastError && <div className="inline-alert error">{lastError}</div>}

      {/* 账户与连接 */}
      <div className="settings-section">
        <div className="settings-section-title">账户与连接</div>
        <div className="card settings-card">
          <div className="settings-row">
            <div>
              <div className="settings-row-label">API Key</div>
              <div className="settings-row-desc">用于连接百炼同声传译模型</div>
            </div>
            <div className="settings-row-value">
              {editingKey ? (
                <>
                  <input className="input" style={{ width: '200px' }} type="password" placeholder="sk-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
                  <button className="btn btn-primary btn-sm" disabled={busy || !keyDraft} onClick={() => { void store.saveApiKey(keyDraft); setKeyDraft(''); setEditingKey(false); }}>保存</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingKey(false)}>取消</button>
                </>
              ) : (
                <>
                  <span className="key-masked">{hasKey ? maskedKey : '未配置'}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingKey(true)}><Pencil size={13} />编辑</button>
                </>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div><div className="settings-row-label">Workspace Host</div></div>
            <div className="settings-row-value">
              {editingHost ? (
                <>
                  <input className="input" style={{ width: '240px' }} value={hostDraft} onChange={(e) => setHostDraft(e.target.value)} />
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void store.saveSettings({ workspaceHost: hostDraft }); setEditingHost(false); }}>保存</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingHost(false)}>取消</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{settings.workspaceHost || '—'}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingHost(true)}><Pencil size={13} />编辑</button>
                </>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div><div className="settings-row-label">连接状态</div></div>
            <div className="settings-row-value">
              {selfCheck ? (
                selfCheck.ok ? (
                  <>
                    <span className="status-dot online" />
                    <span style={{ fontSize: '13px', color: 'var(--color-success)', fontWeight: 550 }}>已连接 · {selfCheck.latencyMs}ms</span>
                  </>
                ) : (
                  <>
                    <span className="status-dot offline" />
                    <span style={{ fontSize: '13px', color: 'var(--color-error)', fontWeight: 550 }}>失败：{selfCheck.reason}</span>
                  </>
                )
              ) : (
                <span style={{ fontSize: '13px', color: 'var(--color-text-tertiary)' }}>未检测</span>
              )}
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void store.runSelfCheck()}>重新检测</button>
            </div>
          </div>
        </div>
      </div>

      {/* 翻译偏好 */}
      <div className="settings-section">
        <div className="settings-section-title">翻译偏好</div>
        <div className="card settings-card">
          <div className="settings-row">
            <div><div className="settings-row-label">默认语言对</div></div>
            <div className="settings-row-value" style={{ gap: 'var(--space-2)' }}>
              <select className="select" style={{ width: '120px' }} value={settings.sourceLanguage}
                onChange={(e) => void store.saveSettings({ sourceLanguage: e.target.value })}>
                <option value="auto">自动检测</option>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
              <span style={{ color: 'var(--color-text-tertiary)' }}>→</span>
              <select className="select" style={{ width: '120px' }} value={settings.targetLanguage}
                onChange={(e) => void store.saveSettings({ targetLanguage: e.target.value })}>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
          </div>
          <div className="settings-row">
            <div><div className="settings-row-label">默认音色</div></div>
            <div className="settings-row-value">
              <select className="select" style={{ width: '160px' }} value={settings.defaultVoice}
                onChange={(e) => void store.saveSettings({ defaultVoice: e.target.value })}>
                <option value="Tina">Tina（默认）</option>
                <option value="Cherry">Cherry</option>
                <option value="Ethan">Ethan</option>
              </select>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">协议偏好</div>
              <div className="settings-row-desc">WebRTC 可提供更好的抗噪表现（需开通白名单）</div>
            </div>
            <div className="settings-row-value">
              <select className="select" style={{ width: '160px' }} value={settings.protocolPreference}
                onChange={(e) => void store.saveSettings({ protocolPreference: e.target.value as 'auto' | 'ws' })}>
                <option value="auto">自动（推荐）</option>
                <option value="ws">强制 WebSocket</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* 热词表 */}
      <div className="settings-section">
        <div className="settings-section-title">热词表</div>
        <div className="card settings-card">
          {settings.hotwordTables.map((t, ti) => (
            <HotwordRow key={t.name} table={t} busy={busy} onChange={(next) => {
              const tables = next
                ? settings.hotwordTables.map((cur, i) => (i === ti ? next : cur))
                : settings.hotwordTables.filter((_, i) => i !== ti);
              void store.saveSettings({ hotwordTables: tables });
            }} />
          ))}
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <input className="input" style={{ width: '180px' }} value={tableDraft} placeholder="词表名称" onChange={(e) => setTableDraft(e.target.value)} />
            <button className="btn btn-secondary btn-sm" disabled={busy || !tableDraft.trim()} onClick={() => {
              void store.saveSettings({ hotwordTables: [...settings.hotwordTables, { name: tableDraft.trim(), phrases: [] }] });
              setTableDraft('');
            }}><Plus size={14} />新建词表</button>
          </div>
        </div>
      </div>

      {/* 高级 */}
      <div className="settings-section">
        <div className="card settings-card" style={{ paddingTop: 0, paddingBottom: 'var(--space-3)' }}>
          <div className="collapse-header" onClick={() => setAdvOpen(!advOpen)}>
            <div>
              <div className="settings-section-title" style={{ marginBottom: 0 }}>高级</div>
              <div className="settings-row-desc">开发调试选项</div>
            </div>
            <span className="session-expand-icon" style={{ transform: advOpen ? 'rotate(180deg)' : '' }}><ChevronDown size={16} /></span>
          </div>
          <div className={`collapse-body${advOpen ? ' open' : ''}`}>
            <div className="settings-row">
              <div><div className="settings-row-label">视频抽帧帧率</div></div>
              <select className="select" style={{ width: '120px' }} value={settings.frameExtraction.fps}
                onChange={(e) => void store.saveSettings({ frameExtraction: { ...settings.frameExtraction, fps: Number(e.target.value) as 1 | 2 } })}>
                <option value={1}>1 fps</option>
                <option value={2}>2 fps</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-row-label">完整音频负载日志</div>
                <div className="settings-row-desc">记录未截断的 base64 音频数据（体积较大）</div>
              </div>
              <button className={`switch${settings.fullAudioLogs ? ' on' : ''}`} role="switch" aria-checked={settings.fullAudioLogs} aria-label="完整音频负载日志"
                onClick={() => void store.saveSettings({ fullAudioLogs: !settings.fullAudioLogs })} />
            </div>
            <div className="settings-row">
              <div><div className="settings-row-label">视觉增强</div></div>
              <button className={`switch${settings.frameExtraction.enabled ? ' on' : ''}`} role="switch" aria-checked={settings.frameExtraction.enabled} aria-label="视觉增强"
                onClick={() => void store.saveSettings({ frameExtraction: { ...settings.frameExtraction, enabled: !settings.frameExtraction.enabled } })} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function HotwordRow(props: { table: HotwordTableDto; busy: boolean; onChange(next: HotwordTableDto | null): void }): JSX.Element {
  const { table, busy, onChange } = props;
  const [editing, setEditing] = useState(false);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');

  if (!editing) {
    return (
      <div className="hotword-item">
        <div><span className="hotword-name">{table.name}</span> <span className="hotword-count">· {table.phrases.length} 条</span></div>
        <div className="hotword-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}><Pencil size={13} />编辑</button>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--color-text-tertiary)' }} disabled={busy} onClick={() => onChange(null)}><Trash2 size={13} />删除</button>
        </div>
      </div>
    );
  }

  return (
    <div className="hotword-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="hotword-name">{table.name}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>收起</button>
      </div>
      {table.phrases.map((p, pi) => <div key={pi} style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{p.source} → {p.target}</div>)}
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <input className="input" style={{ flex: 1 }} value={source} placeholder="原文" onChange={(e) => setSource(e.target.value)} />
        <input className="input" style={{ flex: 1 }} value={target} placeholder="译文" onChange={(e) => setTarget(e.target.value)} />
        <button className="btn btn-secondary btn-sm" disabled={busy || !source || !target} onClick={() => {
          onChange({ ...table, phrases: [...table.phrases, { source, target }] });
          setSource(''); setTarget('');
        }}>加词条</button>
      </div>
    </div>
  );
}
