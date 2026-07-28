import { useEffect, useState } from 'react';

export function DevicePicker({ kind, value, onChange }: {
  kind: 'audioinput' | 'audiooutput';
  value: string;
  onChange: (deviceId: string, label: string) => void;
}): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (alive) setDevices(all.filter((d) => d.kind === kind));
    };
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, [kind]);
  return (
    <select
      className="device-picker"
      value={value}
      onChange={(e) => {
        const dev = devices.find((d) => d.deviceId === e.target.value);
        onChange(e.target.value, dev?.label ?? '');
      }}
    >
      <option value="">请选择设备…</option>
      {devices.map((d) => (
        <option key={d.deviceId} value={d.deviceId}>{d.label || `设备 ${d.deviceId.slice(0, 8)}`}</option>
      ))}
    </select>
  );
}
