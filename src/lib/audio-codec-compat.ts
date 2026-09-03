/**
 * 浏览器音频编解码器兼容性检测
 *
 * 目的: 当 moontv 用户播放 Emby 影片时,自动检测音频格式是否被当前浏览器支持。
 *       对于不支持的格式(DTS-HD MA / TrueHD / DTS / AC3 等),弹友好提示并引导用户:
 *       - 换 Edge / Safari (支持 AC3/EAC3)
 *       - 安装 Emby 客户端 (完整 DTS/TrueHD 解码)
 *
 * 设计:
 * - 纯前端 utility,无后端依赖
 * - 不阻断播放,只是提示
 * - 用户 dismiss 后 localStorage 记住,不再骚扰
 */

export type BrowserType =
  | 'chrome'
  | 'firefox'
  | 'edge'
  | 'safari'
  | 'opera'
  | 'unknown';

export interface AudioTrack {
  index: number;
  codec?: string;
  language?: string;
  displayTitle?: string;
  isDefault?: boolean;
}

/**
 * 浏览器对音频编解码器的支持矩阵
 * - Chrome / Firefox / Opera: 仅 AAC / MP3 / Opus / Vorbis / FLAC (无 AC3)
 * - Edge / Safari: 加上 AC3 / EAC3 (微软 / 苹果内置)
 * - DTS / DTS-HD MA / TrueHD: 所有浏览器都不支持 (需要客户端或硬件解码)
 */
const BROWSER_CODEC_SUPPORT: Record<BrowserType, Set<string>> = {
  chrome: new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm']),
  firefox: new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm']),
  edge: new Set([
    'aac',
    'mp3',
    'opus',
    'vorbis',
    'flac',
    'pcm',
    'ac-3',
    'eac3',
    'ec-3',
    'alac',
  ]),
  safari: new Set([
    'aac',
    'mp3',
    'opus',
    'flac',
    'pcm',
    'ac-3',
    'eac3',
    'ec-3',
    'alac',
  ]),
  opera: new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm']),
  unknown: new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm']),
};

/**
 * 将 Emby 返回的 codec 字符串归一化到我们内部用的 token
 * Emby 可能返回: aac, mp3, opus, vorbis, flac, ac-3, ec-3, eac3, dca (dts),
 *                dtshd, truehd, mlp (truehd 的容器)
 */
export function normalizeCodec(codec: string): string {
  if (!codec) return '';
  const c = codec.toLowerCase().replace(/[\s_-]/g, '');
  // DTS 系
  if (c.includes('dtshd') || c.includes('dtshdma')) return 'dtshd';
  if (c === 'dca' || c === 'dts') return 'dts';
  // Dolby 系
  if (c.includes('truehd') || c === 'mlp') return 'truehd';
  if (c === 'ac3' || c === 'ac-3') return 'ac-3';
  if (c === 'eac3' || c === 'ec-3') return 'eac3';
  // AAC 系 (mp4a.40.2, mp4a.40.5, etc)
  if (c.startsWith('mp4a') || c === 'aac') return 'aac';
  // 其它通用
  if (c === 'mp3' || c === 'mpeg') return 'mp3';
  if (c === 'opus') return 'opus';
  if (c === 'vorbis' || c === 'ogg') return 'vorbis';
  if (c === 'flac') return 'flac';
  if (c === 'alac' || c === 'apple') return 'alac';
  if (c === 'pcm' || c === 'lpcm') return 'pcm';
  return c; // 未知 codec 原样返回
}

/**
 * 检测当前浏览器类型
 * 通过 navigator.userAgent 判断
 */
export function detectBrowser(): BrowserType {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  // Edge 必须先于 Chrome 判 (Edge UA 也含 chrome)
  if (ua.includes('edg/') || ua.includes('edge/')) return 'edge';
  // Opera (含 OPR/Opera)
  if (ua.includes('opera') || ua.includes('opr/')) return 'opera';
  // Firefox
  if (ua.includes('firefox') || ua.includes('fxios')) return 'firefox';
  // Safari (必须排除 Chrome,因 Chrome UA 也含 Safari)
  if (ua.includes('safari') && !ua.includes('chrome')) return 'safari';
  // Chrome (兜底)
  if (ua.includes('chrome') || ua.includes('chromium')) return 'chrome';
  return 'unknown';
}

/**
 * 判断音频编解码器是否被指定浏览器支持
 */
export function isCodecSupported(codec: string, browser: BrowserType): boolean {
  const supported = BROWSER_CODEC_SUPPORT[browser] || BROWSER_CODEC_SUPPORT.unknown;
  return supported.has(normalizeCodec(codec));
}

/**
 * 从一组音轨中,找出当前浏览器**都不支持**的 codec 列表 (去重)
 */
export function getIncompatibleCodecs(
  tracks: AudioTrack[],
  browser: BrowserType,
): string[] {
  const supported = BROWSER_CODEC_SUPPORT[browser] || BROWSER_CODEC_SUPPORT.unknown;
  const seen = new Set<string>();
  for (const t of tracks) {
    if (!t.codec) continue;
    const norm = normalizeCodec(t.codec);
    if (norm && !supported.has(norm)) {
      seen.add(norm);
    }
  }
  return Array.from(seen);
}

/**
 * 是否有任何一条音轨不被当前浏览器支持
 * 注意: 即便有支持的音轨,只要有不支持的,也建议提示 (用户可能切错音轨)
 */
export function hasIncompatibleAudio(
  tracks: AudioTrack[],
  browser: BrowserType,
): boolean {
  return getIncompatibleCodecs(tracks, browser).length > 0;
}

/**
 * 获取 codec 的友好显示名称
 */
export function getCodecDisplayName(codec: string): string {
  const norm = normalizeCodec(codec);
  const names: Record<string, string> = {
    dtshd: 'DTS-HD MA',
    dts: 'DTS',
    truehd: 'Dolby TrueHD',
    'ac-3': 'Dolby AC-3',
    eac3: 'Dolby E-AC3',
    aac: 'AAC',
    mp3: 'MP3',
    opus: 'Opus',
    vorbis: 'Vorbis',
    flac: 'FLAC',
    alac: 'ALAC',
    pcm: 'PCM',
  };
  return names[norm] || codec.toUpperCase();
}

/**
 * 浏览器友好名称
 */
export function getBrowserDisplayName(browser: BrowserType): string {
  const map: Record<BrowserType, string> = {
    chrome: 'Chrome',
    firefox: 'Firefox',
    edge: 'Edge',
    safari: 'Safari',
    opera: 'Opera',
    unknown: '当前浏览器',
  };
  return map[browser];
}
