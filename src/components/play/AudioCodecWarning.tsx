'use client';

/**
 * AudioCodecWarning - 浏览器音频编解码器不兼容提示
 *
 * 触发场景: 用户在 moontv 播放 Emby 影片,音频格式是浏览器不支持的
 *          (DTS-HD MA / TrueHD / DTS 等 4K 原盘常见格式)
 *
 * 行为:
 * - 在播放器顶部弹出友好提示(可关闭)
 * - 关闭后用 localStorage 记住,本会话不再骚扰
 * - 不阻断播放,只是引导用户:
 *   ① 装 Kodi + Emby 插件 (跨平台、全免费、自带 DTS 解码)
 *   ② 或换 Edge / Safari (支持 Dolby AC-3)
 *
 * 服务端无依赖,纯前端组件。
 */

import React, { useEffect, useMemo, useState } from 'react';

import {
  detectBrowser,
  getBrowserDisplayName,
  getCodecDisplayName,
  getIncompatibleCodecs,
  hasIncompatibleAudio,
  type AudioTrack,
  type BrowserType,
} from '@/lib/audio-codec-compat';

interface AudioCodecWarningProps {
  /** 当前影片的音轨列表 (来自 Emby /api/emby/audio-streams) */
  tracks: AudioTrack[];
  /** 自定义测试 ID (便于 e2e) */
  testId?: string;
}

// localStorage key: 用户 dismiss 后不再提示
const DISMISS_KEY = 'lunatv_audio_codec_warning_dismissed_v1';

export const AudioCodecWarning: React.FC<AudioCodecWarningProps> = ({
  tracks,
  testId = 'audio-codec-warning',
}) => {
  const [browser, setBrowser] = useState<BrowserType>('unknown');
  const [dismissed, setDismissed] = useState(true); // 默认隐藏,SSR-safe
  const [mounted, setMounted] = useState(false);

  // 仅客户端挂载后才检测 browser / 读 localStorage
  useEffect(() => {
    setBrowser(detectBrowser());
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      // localStorage 可能被禁用 (隐私模式等),降级到每次都提示
      setDismissed(false);
    }
    setMounted(true);
  }, []);

  // 检测是否需要显示
  const incompatibleCodecs = useMemo(() => {
    if (!mounted || tracks.length === 0) return [];
    return getIncompatibleCodecs(tracks, browser);
  }, [mounted, tracks, browser]);

  const shouldShow =
    mounted && !dismissed && hasIncompatibleAudio(tracks, browser);

  if (!shouldShow) return null;

  const codecList = incompatibleCodecs.map(getCodecDisplayName).join(' / ');
  const browserName = getBrowserDisplayName(browser);

  // 是否需要建议换浏览器
  const isLimitedBrowser =
    browser === 'chrome' || browser === 'firefox' || browser === 'opera';
  const isAdvancedBrowser = browser === 'edge' || browser === 'safari';
  const isUnknown = browser === 'unknown';

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // 忽略,即便存储失败也更新 state
    }
    setDismissed(true);
  };

  return (
    <div
      data-testid={testId}
      role="alert"
      aria-live="polite"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] w-[calc(100%-1.5rem)] max-w-2xl
                 rounded-lg border border-yellow-300 dark:border-yellow-700
                 bg-gradient-to-br from-yellow-50 to-amber-50 dark:from-yellow-900/85 dark:to-amber-900/85
                 shadow-lg backdrop-blur-sm
                 px-3 py-3 sm:px-4 sm:py-4"
    >
      <div className="flex items-start gap-3">
        {/* 左侧图标 */}
        <div
          aria-hidden="true"
          className="flex-shrink-0 text-xl sm:text-2xl leading-none mt-0.5"
        >
          ⚠️
        </div>

        {/* 中间内容 */}
        <div className="flex-1 min-w-0 text-yellow-900 dark:text-yellow-100">
          <h3 className="text-sm sm:text-base font-semibold leading-snug mb-1.5">
            本片音频格式 {codecList} — 浏览器可能无声
          </h3>

          <div className="text-xs sm:text-sm leading-relaxed space-y-2">
            {/* 浏览器兼容性说明 */}
            <p>
              {isLimitedBrowser && (
                <>
                  你的浏览器 <strong>{browserName}</strong> 不支持 {codecList}
                  这类高清音轨,会导致播放时无声或报错。
                </>
              )}
              {isAdvancedBrowser && (
                <>
                  虽然 <strong>{browserName}</strong> 支持部分高清音轨,但本片为{' '}
                  {codecList}
                  ,仍可能需要服务端转码才能正常播放。
                </>
              )}
              {isUnknown && (
                <>
                  当前浏览器可能不支持 {codecList} 这类高清音轨,会导致播放时无声。
                </>
              )}
            </p>

            {/* 解决方案 */}
            <div>
              <p className="font-medium mb-1">🛠️ 推荐解决方案:</p>
              <ol className="list-decimal list-inside space-y-1.5 ml-1">
                <li>
                  🥇 装 <strong>Kodi</strong> + Emby 插件(全平台、全免费、自带 DTS-HD MA 解码):
                  <br />
                  <a
                    href="https://zhuanlan.zhihu.com/p/601657805"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-1 text-blue-700 dark:text-blue-300 underline hover:text-blue-900 dark:hover:text-blue-100 break-all"
                  >
                    📖 查看完整图文教程(知乎)
                  </a>
                </li>
                {isLimitedBrowser && (
                  <li>
                    或用 <strong>Edge</strong> / <strong>Safari</strong> 浏览器打开 moontv
                    (支持 Dolby AC-3)
                  </li>
                )}
              </ol>
            </div>
          </div>
        </div>

        {/* 右侧关闭按钮 */}
        <button
          onClick={handleDismiss}
          aria-label="关闭提示 (本会话不再显示)"
          title="关闭提示 (本会话不再显示)"
          className="flex-shrink-0 -mt-1 -mr-1 p-1.5 rounded-md
                     text-yellow-700 dark:text-yellow-300
                     hover:bg-yellow-200/50 dark:hover:bg-yellow-800/50
                     hover:text-yellow-900 dark:hover:text-yellow-100
                     transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4 sm:w-5 sm:h-5"
          >
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default AudioCodecWarning;
