export interface LanguageInfo {
  code: string;
  name: string;
  audio: boolean; // 目标语言是否支持音频输出
}

// 音频支持 29 种
const AUDIO: Array<[string, string]> = [
  ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['es', '西班牙语'],
  ['fr', '法语'], ['de', '德语'], ['ru', '俄语'], ['pt', '葡萄牙语'], ['it', '意大利语'],
  ['ar', '阿拉伯语'], ['hi', '印地语'], ['id', '印尼语'], ['th', '泰语'], ['vi', '越南语'],
  ['ms', '马来语'], ['tr', '土耳其语'], ['nl', '荷兰语'], ['pl', '波兰语'], ['sv', '瑞典语'],
  ['da', '丹麦语'], ['no', '挪威语'], ['fi', '芬兰语'], ['cs', '捷克语'], ['el', '希腊语'],
  ['he', '希伯来语'], ['hu', '匈牙利语'], ['ro', '罗马尼亚语'], ['uk', '乌克兰语'],
];
// 仅文本 31 种
const TEXT_ONLY: Array<[string, string]> = [
  ['bn', '孟加拉语'], ['ur', '乌尔都语'], ['fa', '波斯语'], ['ta', '泰米尔语'], ['te', '泰卢固语'],
  ['mr', '马拉地语'], ['gu', '古吉拉特语'], ['kn', '卡纳达语'], ['ml', '马拉雅拉姆语'], ['pa', '旁遮普语'],
  ['si', '僧伽罗语'], ['my', '缅甸语'], ['km', '高棉语'], ['lo', '老挝语'], ['fil', '菲律宾语'],
  ['sw', '斯瓦希里语'], ['am', '阿姆哈拉语'], ['az', '阿塞拜疆语'], ['kk', '哈萨克语'], ['uz', '乌兹别克语'],
  ['mn', '蒙古语'], ['ne', '尼泊尔语'], ['sk', '斯洛伐克语'], ['sl', '斯洛文尼亚语'], ['hr', '克罗地亚语'],
  ['sr', '塞尔维亚语'], ['bg', '保加利亚语'], ['lt', '立陶宛语'], ['lv', '拉脱维亚语'], ['et', '爱沙尼亚语'],
  ['bo', '藏语'],
];

export const LANGUAGES: LanguageInfo[] = [
  ...AUDIO.map(([code, name]) => ({ code, name, audio: true })),
  ...TEXT_ONLY.map(([code, name]) => ({ code, name, audio: false })),
];

export function supportsAudioOutput(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code && l.audio);
}
