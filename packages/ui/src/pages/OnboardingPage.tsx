import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, AudioLines, Users, Check, Globe } from 'lucide-react';
import { createGatewayApi } from '../api';

type Step = 1 | 2 | 3;

export function OnboardingPage(): JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(1);
  const [apiKey, setApiKey] = useState('');
  const [host, setHost] = useState('https://dashscope.aliyuncs.com');
  const [testing, setTesting] = useState(false);
  const [connResult, setConnResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function testConnection(): Promise<void> {
    setTesting(true);
    setConnResult(null);
    try {
      const api = createGatewayApi();
      await api.postSettings({ apiKey, patch: { workspaceHost: host } });
      const result = await api.selfCheck();
      if (result.ok) {
        setConnResult({ ok: true, msg: `连接成功 · 延迟 ${result.latencyMs}ms` });
        setTimeout(() => setStep(3), 900);
      } else {
        setConnResult({ ok: false, msg: `连接失败：${result.reason}` });
      }
    } catch (e) {
      setConnResult({ ok: false, msg: `连接失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  function finish(): void {
    navigate('/live', { replace: true });
    window.location.reload();
  }

  return (
    <div className="onboarding">
      <div className="ob-panel">
        <div className="ob-steps">
          <div className={`ob-step-dot${step === 1 ? ' active' : step > 1 ? ' done' : ''}`} />
          <div className={`ob-step-dot${step === 2 ? ' active' : step > 2 ? ' done' : ''}`} />
          <div className={`ob-step-dot${step === 3 ? ' active' : ''}`} />
        </div>

        {step === 1 && (
          <div>
            <div className="ob-logo">
              <Globe viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
            </div>
            <h1 className="ob-title">LiveTranslate</h1>
            <p className="ob-desc">实时同声传译，三种方式使用</p>
            <div className="ob-modes">
              <div className="ob-mode-card">
                <div className="ob-mode-icon"><Mic size={18} /></div>
                <div className="ob-mode-name">实时翻译</div>
                <div className="ob-mode-desc">对着麦克风说话，即刻看到、听到译文</div>
              </div>
              <div className="ob-mode-card">
                <div className="ob-mode-icon"><AudioLines size={18} /></div>
                <div className="ob-mode-name">文件配音</div>
                <div className="ob-mode-desc">导入音视频，自动生成多语言配音</div>
              </div>
              <div className="ob-mode-card">
                <div className="ob-mode-icon"><Users size={18} /></div>
                <div className="ob-mode-name">会议翻译</div>
                <div className="ob-mode-desc">多人轮流发言，以发言人音色播放译文</div>
              </div>
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => setStep(2)}>开始设置</button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h1 className="ob-title">连接你的翻译引擎</h1>
            <p className="ob-desc">输入 API Key，连接百炼同声传译模型</p>
            <div className="ob-form">
              <div className="field">
                <label className="label">API Key</label>
                <input className="input" type="password" placeholder="sk-xxxxxxxxxxxxxxxx" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
              <div className="field">
                <label className="label">Workspace Host</label>
                <input className="input" type="text" value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <button className="btn btn-primary" style={{ width: '100%' }} disabled={testing || !apiKey} onClick={() => void testConnection()}>
                {testing ? '连接中…' : '测试连接'}
              </button>
              {connResult?.ok && (
                <div className="ob-success show">
                  <Check size={14} strokeWidth={2.5} />
                  {connResult.msg}
                </div>
              )}
              {connResult && !connResult.ok && (
                <div className="inline-alert error" style={{ marginTop: 'var(--space-4)' }}>{connResult.msg}</div>
              )}
              <p style={{ marginTop: 'var(--space-4)', textAlign: 'center' }}>
                <a className="ob-link" href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">在哪里获取 API Key？→</a>
              </p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="ob-ready-icon">
              <Check size={28} strokeWidth={2.5} />
            </div>
            <h1 className="ob-title">一切就绪</h1>
            <p className="ob-desc">模型已连接，默认翻译方向：中文 → 英语<br />之后可随时在设置中调整</p>
            <button className="btn btn-primary btn-lg" onClick={finish}>试试对着麦克风说句话？</button>
            <p style={{ marginTop: 'var(--space-4)' }}>
              <button className="ob-link" onClick={finish} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>先看看其他功能</button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
