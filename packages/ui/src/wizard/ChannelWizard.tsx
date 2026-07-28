import { useEffect, useRef, useState } from 'react';
import { OUTPUT_SAMPLE_RATE, pcm16ToWav } from '@livetranslate/core';
import { startMicCapture, type MicCaptureHandle } from '../audio/micCapture';
import { createPlayerSink } from '../audio/playerSink';
import { DevicePicker } from '../components/DevicePicker';
import { VolumeMeter } from '../components/VolumeMeter';
import { isSuspectedSpeaker, makeTestTonePcm } from './wizardRules';

export interface ChannelChoice {
  inputDeviceId: string;
  outputDeviceId: string;
}

// 三步强制向导：任何一步未达标不得进入运行界面（spec §5.3）。
export function ChannelWizard({ onComplete }: { onComplete: (choice: ChannelChoice) => void }): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [inputId, setInputId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [outputLabel, setOutputLabel] = useState('');
  const [level, setLevel] = useState(0);
  const [hasSignal, setHasSignal] = useState(false);   // 步骤①：音量条动过才算通过
  const [toneTested, setToneTested] = useState(false); // 步骤②：至少播过一次测试音
  const [headphoneConfirmed, setHeadphoneConfirmed] = useState(false); // 步骤③强制勾选
  const captureRef = useRef<MicCaptureHandle | null>(null);
  const sinkRef = useRef(createPlayerSink());

  // 步骤①：选中设备即启动采集，实时驱动音量条（向导阶段不推流）
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
    <div className="wizard">
      {step === 1 && (
        <section className="wizard-step">
          <h2>① 选择收音设备</h2>
          <DevicePicker kind="audioinput" value={inputId} onChange={(id) => { setInputId(id); setHasSignal(false); }} />
          <VolumeMeter level={level} />
          <p className="hint">对着话筒说话，看到音量条摆动即可继续。</p>
          <button disabled={!inputId || !hasSignal} onClick={() => setStep(2)}>下一步</button>
        </section>
      )}
      {step === 2 && (
        <section className="wizard-step">
          <h2>② 选择播音设备</h2>
          <DevicePicker kind="audiooutput" value={outputId} onChange={(id, label) => { setOutputId(id); setOutputLabel(label); setToneTested(false); }} />
          <button disabled={!outputId} onClick={() => { void playTestTone(); }}>播放测试音</button>
          <p className="hint">应从所选设备听到 0.6 秒提示音。</p>
          <button disabled={!outputId || !toneTested} onClick={() => setStep(3)}>下一步</button>
        </section>
      )}
      {step === 3 && (
        <section className="wizard-step">
          <h2>③ 回环自检</h2>
          <p>收音：{inputId}</p>
          <p>播音：{outputLabel || outputId}</p>
          {suspected && (
            <div className="warn-box">
              <p className="error-text">输出设备疑似外放扬声器：翻译语音会被话筒重新拾取，造成回环自翻译。</p>
              <label>
                <input type="checkbox" checked={headphoneConfirmed} onChange={(e) => setHeadphoneConfirmed(e.target.checked)} />
                我已确认使用耳机
              </label>
            </div>
          )}
          <button disabled={suspected && !headphoneConfirmed} onClick={finish}>完成，进入运行界面</button>
        </section>
      )}
    </div>
  );
}
