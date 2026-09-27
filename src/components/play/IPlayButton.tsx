'use client';

import { useState } from 'react';

interface IPlayButtonProps {
  videoUrl: string;
  isEmbySource: boolean;
  /** 按钮样式：toolbar（工具栏小按钮）或 error（错误页大按钮） */
  variant?: 'toolbar' | 'error';
}

const IPLAY_SITE = 'https://iplay.saltpi.cn/';
const GUIDE_SEEN_KEY = 'iplay_guide_seen';

/** 新手引导弹窗：指导下载安装 iPlay */
function IPlayGuideModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: () => void }) {
  return (
    <div
      className='fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4'
      onClick={onClose}
    >
      <div
        className='w-full max-w-md rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-2xl'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='text-lg font-bold text-gray-900 dark:text-gray-100 mb-3'>
          用 iPlay 播放
        </h3>
        <div className='text-sm text-gray-600 dark:text-gray-300 space-y-3 leading-relaxed'>
          <p>
            这部影片的格式浏览器播不了。iPlay 是免费开源播放器，能硬解全格式音频，装好后点一下就能看。
          </p>
          <ol className='list-decimal list-inside space-y-1.5'>
            <li>
              前往官网下载安装
              <a
                href={IPLAY_SITE}
                target='_blank'
                rel='noopener noreferrer'
                className='ml-1 text-blue-600 dark:text-blue-400 underline underline-offset-2 font-medium'
              >
                iPlay 官网
              </a>
              <span className='text-gray-400'>（支持 Windows / macOS / 安卓 / iOS）</span>
            </li>
            <li>安装完成后回到本页面</li>
            <li>点击下方「已安装，去播放」，iPlay 会自动打开并播放</li>
          </ol>
        </div>
        <div className='flex gap-3 mt-6'>
          <button
            onClick={onClose}
            className='flex-1 px-4 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className='flex-1 px-4 py-2.5 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors'
          >
            已安装，去播放
          </button>
        </div>
      </div>
    </div>
  );
}

export default function IPlayButton({ videoUrl, isEmbySource, variant = 'toolbar' }: IPlayButtonProps) {
  const [showGuide, setShowGuide] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!isEmbySource) return null;

  /** 向后端换一次性令牌，拼出 iplay:// 深链并唤起 */
  const launchIPlay = async () => {
    const raw = (videoUrl || '').trim();
    if (!raw || loading) return;
    setLoading(true);
    try {
      const resp = await fetch('/api/emby/iplay-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw }),
      });
      const data = await resp.json().catch(() => null);
      const playUrl: string = data?.playUrl || '';
      if (!playUrl) throw new Error(data?.error || '令牌签发失败');
      // 注意：不要对 base64 做 encodeURIComponent，iPlay 桌面版不做 URL 解码直接 Base64 解码
      const b64 = btoa(unescape(encodeURIComponent(playUrl)));
      // Windows 桌面版只认 source 参数里的 JSON（{"video":"..."}），不认 type=url&url；
      // 安卓版认 type=url&url。两个都带上，双端兼容。
      const sourceJson = encodeURIComponent(JSON.stringify({ video: playUrl }));
      window.location.href = `iplay://play/any?type=url&url=${b64}&source=${sourceJson}`;
    } catch (e) {
      alert(`唤起 iPlay 失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleClick = () => {
    try {
      if (!localStorage.getItem(GUIDE_SEEN_KEY)) {
        setShowGuide(true);
        return;
      }
    } catch {
      // localStorage 不可用时直接走流程
    }
    launchIPlay();
  };

  const handleGuideConfirm = () => {
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, '1');
    } catch {
      // 忽略
    }
    setShowGuide(false);
    launchIPlay();
  };

  if (variant === 'error') {
    return (
      <>
        <button
          onClick={handleClick}
          disabled={loading}
          className='w-full px-6 py-3 bg-linear-to-r from-blue-500 to-indigo-600 text-white rounded-xl font-medium hover:from-blue-600 hover:to-indigo-700 transform hover:scale-105 transition-all duration-200 shadow-lg hover:shadow-xl disabled:opacity-60'
        >
          {loading ? '⏳ 正在准备…' : '▶️ 用 iPlay 播放'}
        </button>
        {showGuide && (
          <IPlayGuideModal onClose={() => setShowGuide(false)} onConfirm={handleGuideConfirm} />
        )}
      </>
    );
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={loading}
        title='用本地 iPlay 播放（硬解全格式音频）'
        className='flex items-center gap-1.5 px-3 py-1.5 text-xs sm:text-sm rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors disabled:opacity-60'
      >
        <span aria-hidden='true'>▶️</span>
        <span>{loading ? '准备中…' : 'iPlay 播放'}</span>
      </button>
      {showGuide && (
        <IPlayGuideModal onClose={() => setShowGuide(false)} onConfirm={handleGuideConfirm} />
      )}
    </>
  );
}
