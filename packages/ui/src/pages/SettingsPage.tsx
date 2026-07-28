import { useEffect, useMemo, useReducer, useState } from 'react';
import { createGatewayApi } from '../api';
import type { HotwordTableDto } from '../api';
import { SettingsUiStore } from '../state/settingsStore';

// 计划稿只支持建/删词表；验收要求可加词条，这里补最小的行内编辑（偏差已报告）
function HotwordTableCard(props: { table: HotwordTableDto; busy: boolean; onChange(next: HotwordTableDto | null): void }): JSX.Element {
  const { table, busy, onChange } = props;
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  return (
    <div className="segment-card">
      <strong>{table.name}</strong>
      {table.phrases.map((p, pi) => <div key={pi}>{p.source} → {p.target}</div>)}
      <div>
        <input value={source} placeholder="原文" aria-label={`${table.name} 原文`} onChange={(e) => setSource(e.target.value)} />
        <input value={target} placeholder="译文" aria-label={`${table.name} 译文`} onChange={(e) => setTarget(e.target.value)} />
        <button disabled={busy || !source || !target} onClick={() => {
          onChange({ ...table, phrases: [...table.phrases, { source, target }] });
          setSource('');
          setTarget('');
        }}>加词条</button>
        <button className="secondary" disabled={busy} onClick={() => onChange(null)}>删除词表</button>
      </div>
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const store = useMemo(() => new SettingsUiStore(createGatewayApi()), []);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [keyDraft, setKeyDraft] = useState('');
  const [hostDraft, setHostDraft] = useState('');

  useEffect(() => {
    const off = store.subscribe(force);
    void store.load().then(() => setHostDraft(store.state.settings.workspaceHost));
    return off;
  }, [store]);

  const { settings, maskedKey, hasKey, selfCheck, busy } = store.state;
  return (
    <div>
      <h2>设置</h2>
      <section>
        <h3>连接</h3>
        <label>
          API Key（当前：{hasKey ? maskedKey : '未配置'}）
          <input type="password" value={keyDraft} placeholder="sk-…" onChange={(e) => setKeyDraft(e.target.value)} />
        </label>
        <button disabled={busy || keyDraft.length === 0} onClick={() => { void store.saveApiKey(keyDraft); setKeyDraft(''); }}>保存 Key</button>
        <label>
          Workspace Host
          <input value={hostDraft} placeholder="ws-xxxx.cn-beijing.maas.aliyuncs.com" onChange={(e) => setHostDraft(e.target.value)} />
        </label>
        <button disabled={busy} onClick={() => void store.saveSettings({ workspaceHost: hostDraft })}>保存 Host</button>
        <button className="secondary" disabled={busy} onClick={() => void store.runSelfCheck()}>连接自检</button>
        {selfCheck && (selfCheck.ok
          ? <p>✅ 自检通过：session {selfCheck.sessionId}，往返 {selfCheck.latencyMs}ms</p>
          : <p className="warn-banner">❌ 自检失败：{selfCheck.reason}（401 请检查 Key，并参照百炼开通指引）</p>)}
      </section>
      <section>
        <h3>默认偏好</h3>
        <label>协议
          <select value={settings.protocolPreference} onChange={(e) => void store.saveSettings({ protocolPreference: e.target.value as 'auto' | 'ws' })}>
            <option value="auto">自动（优先 WebRTC）</option>
            <option value="ws">强制 WebSocket</option>
          </select>
        </label>
        <label>默认目标语言
          <input value={settings.targetLanguage} onChange={(e) => void store.saveSettings({ targetLanguage: e.target.value })} />
        </label>
        <label>默认音色
          <input value={settings.defaultVoice} onChange={(e) => void store.saveSettings({ defaultVoice: e.target.value })} />
        </label>
        <label>抽帧视觉增强
          <input type="checkbox" checked={settings.frameExtraction.enabled}
            onChange={(e) => void store.saveSettings({ frameExtraction: { ...settings.frameExtraction, enabled: e.target.checked } })} />
        </label>
        <label>事件日志记录完整音频负载
          <input type="checkbox" checked={settings.fullAudioLogs}
            onChange={(e) => void store.saveSettings({ fullAudioLogs: e.target.checked })} />
        </label>
      </section>
      <section>
        <h3>热词表</h3>
        {settings.hotwordTables.map((t, ti) => (
          <HotwordTableCard key={t.name} table={t} busy={busy} onChange={(next) => {
            const tables = next
              ? settings.hotwordTables.map((cur, i) => (i === ti ? next : cur))
              : settings.hotwordTables.filter((_, i) => i !== ti);
            void store.saveSettings({ hotwordTables: tables });
          }} />
        ))}
        <button onClick={() => {
          const name = window.prompt('词表名称？');
          if (!name) return;
          void store.saveSettings({ hotwordTables: [...settings.hotwordTables, { name, phrases: [] }] });
        }}>新建词表</button>
      </section>
    </div>
  );
}
