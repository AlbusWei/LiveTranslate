import { contextBridge, ipcRenderer } from 'electron';

// 同步获取端口：contextBridge 注入必须先于页面脚本读取 window.livetranslate，
// 计划稿的异步 invoke 在页面早读时会拿不到（竞态），改用 sendSync。
const gatewayPort = ipcRenderer.sendSync('lt:gateway-port') as number;
contextBridge.exposeInMainWorld('livetranslate', { gatewayPort });
