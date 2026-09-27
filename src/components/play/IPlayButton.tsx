'use client';

interface IPlayButtonProps {
  /** 当前播放地址（Emby 直链 / Worker 包裹地址 / VPS 转码 HLS） */
  videoUrl: string;
  /** 是否为 Emby 源，非 Emby 源不渲染 */
  isEmbySource: boolean;
}

/**
 * 把播放地址拼成 iPlay 的 URL Scheme：
 *   iplay://play/any?type=url&url=<base64(播放地址)>
 * iPlay 收到后用 mpv/vlc 本地硬解，全格式音频（DTS-HD MA / TrueHD / EAC3）直解。
 *
 * 注意：如果地址是 CF Worker 包裹的（?url=...），先解出里面的 Emby 源站直链再传，
 * 避免 mpv 经过 Worker 中转时拉流异常。源站域名用户已确认可直连。
 */
function unwrapWorkerUrl(url: string): string {
  try {
    const u = new URL(url);
    const inner = u.searchParams.get('url');
    // 只有 host 是自家 Worker 域名时才解包，避免误伤普通带 url 参数的地址
    if (inner && /mootvapidl\.54321\.asia/i.test(u.hostname)) {
      return inner;
    }
  } catch {
    // 解析失败就原样返回
  }
  return url;
}

function buildIPlayUrl(videoUrl: string): string {
  let absolute = unwrapWorkerUrl((videoUrl || '').trim());
  if (!absolute) return '';
  // 相对地址（如 /api/emby/play/proxy/...）补成绝对地址，否则 iPlay 无法解析
  if (absolute.startsWith('/') && typeof window !== 'undefined') {
    absolute = window.location.origin + absolute;
  }
  try {
    // URL 可能是 ASCII，btoa 前先做 UTF-8 安全处理
    const b64 = btoa(unescape(encodeURIComponent(absolute)));
    // 注意：不要对 b64 做 encodeURIComponent。iPlay 桌面版直接取 url 参数做
    // Base64 解码（不做 URL 解码），编码过的 %2B/%2F/%3D 会导致解码失败。
    // 标准 base64 字符集（A-Za-z0-9+/=）在 query 参数里可直接传递。
    return `iplay://play/any?type=url&url=${b64}`;
  } catch {
    return '';
  }
}

export default function IPlayButton({ videoUrl, isEmbySource }: IPlayButtonProps) {
  if (!isEmbySource) return null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const link = buildIPlayUrl(videoUrl);
    if (!link) return;
    // 用 location 跳转触发系统 URL Scheme，未安装 iPlay 时浏览器无反应（不报错）
    window.location.href = link;
  };

  const disabled = !videoUrl;

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className='flex group relative items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-1.5 sm:py-2 min-h-[40px] sm:min-h-[44px] rounded-2xl bg-linear-to-br from-white/90 via-white/80 to-white/70 hover:from-white hover:via-white/95 hover:to-white/90 dark:from-gray-800/90 dark:via-gray-800/80 dark:to-gray-800/70 dark:hover:from-gray-800 dark:hover:via-gray-800/95 dark:hover:to-gray-800/90 backdrop-blur-md border border-white/60 dark:border-gray-700/60 shadow-[0_2px_8px_rgba(0,0,0,0.04),inset_0_1px_0_rgba(255,255,255,0.25)] dark:shadow-[0_2px_8px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.1)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.3)] dark:hover:shadow-[0_4px_12px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.15)] hover:scale-105 active:scale-95 transition-all duration-300 overflow-hidden disabled:opacity-40 disabled:pointer-events-none'
      title='用 iPlay 播放（本地硬解全格式音频）'
    >
      <div className='absolute inset-0 bg-linear-to-r from-transparent via-white/0 to-transparent group-hover:via-white/30 dark:group-hover:via-white/10 transition-all duration-500'></div>
      <span className='relative z-10 text-sm sm:text-base'>▶️</span>
      <span className='relative z-10 hidden sm:inline text-xs font-medium text-gray-600 dark:text-gray-300'>
        iPlay 播放
      </span>
    </button>
  );
}
