import type { DataChannelLike, PeerLike } from '@livetranslate/core';

export function browserPeerFactory(): PeerLike {
  const pc = new RTCPeerConnection();
  let eventsIn: ((data: string) => void) | null = null;
  const like: PeerLike = {
    createDataChannel: (label: string): DataChannelLike => {
      const dc = pc.createDataChannel(label);
      const dcLike: DataChannelLike = {
        send: (d) => dc.send(d),
        onmessage: null,
        onopen: null,
      };
      dc.onmessage = (ev) => dcLike.onmessage?.(String(ev.data));
      dc.onopen = () => dcLike.onopen?.();
      eventsIn = (data) => dcLike.onmessage?.(data);
      return dcLike;
    },
    addTrack: (track, stream) => { pc.addTrack(track, stream); },
    createOffer: () => pc.createOffer(),
    setLocalDescription: (desc) => pc.setLocalDescription(desc as RTCSessionDescriptionInit),
    setRemoteDescription: (desc) => pc.setRemoteDescription(desc as RTCSessionDescriptionInit),
    close: () => pc.close(),
    ontrack: null,
  };
  pc.ontrack = (ev) => like.ontrack?.({ streams: ev.streams });
  // spec §2.5：服务端事件经其自建的 txt 通道推送，并入同一个 onmessage，对 core 透明
  pc.ondatachannel = (ev) => {
    ev.channel.onmessage = (m) => eventsIn?.(String(m.data));
  };
  return like;
}
