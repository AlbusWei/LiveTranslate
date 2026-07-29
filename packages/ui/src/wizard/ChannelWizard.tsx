import { useEffect, useRef, useState } from 'react';
import { OUTPUT_SAMPLE_RATE, pcm16ToWav } from '@livetranslate/core';
import { Mic, Volume2, Headphones, AlertTriangle } from 'lucide-react';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { createPlayerSink } from '../audio/playerSink';
import { DevicePicker } from '../components/DevicePicker';
import { VolumeMeter } from '../components/VolumeMeter';
import { isSuspectedSpeaker, makeTestTonePcm } from './wizardRules';

export interface ChannelChoice {
  inputDeviceId: string;
  outputDeviceId: string;
}

export function ChannelWizard({ onComplete }: { onComplete: (choice: ChannelChoice) => void }): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [inputId, setInputId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [outputLabel, setOutputLabel] = useState('');
  const [level, setLevel] = useState(0);
  const [hasSignal, setHasSignal] = useState(false);
  const [toneTested, setToneTested] = useState(false);
  const [headphoneConfirmed, setHeadphoneConfirmed] = useState(false);
  const captureRef = useRef<MicCaptureHandle | null>(null);
  const sinkRef = useRef(createPlayerSink());

  useEffect(() => {
    if (!inputId) return;
    let cancelled = false;
    void startMicCapture({
      deviceId: inputId,
      onChunk: () => {},
      onLevel: (rms) => {
        if (cancelled) return;
        setLevel(rms);
        if (rms > 0.01) setHasSignal(true);
      },
    }).then((h) => {
      if (cancelled) h.stop();
      else captureRef.current = h;
    });
    return () => {
      cancelled = true;
      captureRef.current?.stop();
      captureRef.current = null;
    };
  }, [inputId]);

  const playTestTone = async (): Promise<void> => {
    await sinkRef.current.setSink(outputId);
    await sinkRef.current.play(pcm16ToWav(makeTestTonePcm(440, 600, OUTPUT_SAMPLE_RATE), OUTPUT_SAMPLE_RATE));
    setToneTested(true);
  };

  const suspected = isSuspectedSpeaker({ deviceId: outputId, label: outputLabel });
  const finish = (): void => {
    captureRef.current?.stop();
    captureRef.current = null;
    onComplete({ inputDeviceId: inputId, outputDeviceId: outputId });
  };

  return (
    <div className="wizard-overlay">
      <div className="wizard-panel">
        <div className="ob-steps" style={{ marginBottom: 'var(--space-8)' }}>
          <div className={`ob-step-dot${step === 1 ? ' active' : ' done'}`} />
          <div className={`ob-step-dot${step === 2 ? ' active' : step > 2 ? ' done' : ''}`} />
          <div className={`ob-step-dot${step === 3 ? ' active' : ''}`} />
        </div>

        {step === 1 && (
          <div>
            <div className="ob-mode-icon" style={{ width: '48px', height: '48px', marginBottom: 'var(--space-4)' }}><Mic size={22} /></div>
            <h2 className="wizard-title">选择收音设备</h2>
            <p className="wizard-desc">对着话筒说话，看到音量条摆动即可继续</p>
            <div className="wizard-field">
              <label className="label">麦克风</label>
              <DevicePicker kind="audioinput" value={inputId} onChange={(id) => { setInputId(id); setHasSignal(false); }} />
              <VolumeMeter level={level} />
            </div>
            <div className="wizard-actions">
              <button className="btn btn-primary" disabled={!inputId || !hasSignal} onClick={() => setStep(2)}>下一步</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="ob-mode-icon" style={{ width: '48px', height: '48px', marginBottom: 'var(--space-4)' }}><Volume2 size={22} /></div>
            <h2 className="wizard-title">选择播音设备</h2>
            <p className="wizard-desc">应从所选设备听到 0.6 秒提示音</p>
            <div className="wizard-field">
              <label className="label">扬声器 / 耳机</label>
              <DevicePicker kind="audiooutput" value={outputId} onChange={(id, label) => { setOutputId(id); setOutputLabel(label); setToneTested(false); }} />
            </div>
            <div className="wizard-actions">
              <button className="btn btn-secondary" disabled={!outputId} onClick={() => void playTestTone()}>
                <Volume2 size={14} />播放测试音
              </button>
              <button className="btn btn-primary" disabled={!outputId || !toneTested} onClick={() => setStep(3)}>下一步</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="ob-mode-icon" style={{ width: '48px', height: '48px', marginBottom: 'var(--space-4)' }}><Headphones size={22} /></div>
            <h2 className="wizard-title">回环自检</h2>
            <p className="wizard-desc">确认设备配置无误</p>
            <div className="card" style={{ padding: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
              <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-2)' }}>
                收音：{inputId.slice(0, 16)}…
              </div>
              <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
                播音：{outputLabel || outputId.slice(0, 16) + '…'}
              </div>
            </div>
            {suspected && (
              <div className="inline-alert warning" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <AlertTriangle size={14} />
                  <span>输出设备疑似外放扬声器，翻译语音会被话筒重新拾取造成回环。</span>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: '13px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={headphoneConfirmed} onChange={(e) => setHeadphoneConfirmed(e.target.checked)} />
                  我已确认使用耳机
                </label>
              </div>
            )}
            <div className="wizard-actions">
              <button className="btn btn-primary" disabled={suspected && !headphoneConfirmed} onClick={finish}>完成，进入运行界面</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
