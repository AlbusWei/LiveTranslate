import { useState } from 'react';
import { ChannelWizard, type ChannelChoice } from '../wizard/ChannelWizard';

export function InterpreterPage(): JSX.Element {
  const [choice, setChoice] = useState<ChannelChoice | null>(null);
  if (!choice) return <ChannelWizard onComplete={setChoice} />;
  return (
    <div>
      <h2>实时翻译机</h2>
      <p>收音设备：{choice.inputDeviceId}</p>
      <p>播音设备：{choice.outputDeviceId}</p>
    </div>
  );
}
