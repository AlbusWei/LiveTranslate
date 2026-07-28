export const CORE_VERSION = '0.1.0';
export * from './protocol/types';
export { Emitter } from './protocol/emitter';
export { normalizeServerEvent } from './protocol/normalize';
export { bytesToBase64, base64ToBytes } from './audio/base64';
export { WsTransport, type WsLike, type WsTransportOptions } from './protocol/wsTransport';
export { TranscriptModel, type TranscriptSegment, type SegmentStatus } from './session/transcriptModel';
