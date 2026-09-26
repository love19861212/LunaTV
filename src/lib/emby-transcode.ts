/* eslint-disable no-console */
/**
 * Emby VPS 音频转码会话管理（服务端专用）
 *
 * 背景: 部分 Emby 片源（REMUX/源码）只有 DTS-HD MA / TrueHD / DTS 等
 * 浏览器无法解码的音轨，且用户不是 Emby 管理员、无法开启服务端转码。
 * 这里用 VPS 本机的 ffmpeg 做"视频复制 + 音频转 AAC"的实时转码，
 * 输出 HLS(m3u8) 供网页播放器播放，可 seek。
 *
 * 设计要点:
 * - 纯音频转码，CPU 开销小（约 0.2~0.4 核/路）
 * - 会话复用：同一 (embyKey, itemId, 音轨) 只起一个 ffmpeg
 * - HLS 全量保留分片（VOD 风格），会话空闲 20 分钟后回收并删除分片
 * - 并发上限 2 路，磁盘剩余不足 10GB 时拒绝新会话
 */

import { ChildProcess,spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TranscodeSession {
  key: string;
  id: string;
  dir: string;
  proc: ChildProcess | null;
  createdAt: number;
  lastAccess: number;
  failed: boolean;
  failReason?: string;
}

export class TranscodeError extends Error {
  code:
    | 'NO_FFMPEG'
    | 'TOO_MANY'
    | 'NO_DISK'
    | 'START_TIMEOUT'
    | 'FFMPEG_EXIT'
    | 'SESSION_GONE';
  constructor(code: TranscodeError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const sessions = new Map<string, TranscodeSession>();

// 可调参数（环境变量覆盖）
const MAX_SESSIONS = Number(process.env.EMBY_TRANSCODE_MAX || 2);
const IDLE_TIMEOUT_MS = Number(process.env.EMBY_TRANSCODE_IDLE_MS || 20 * 60 * 1000);
const MIN_FREE_BYTES = Number(
  process.env.EMBY_TRANSCODE_MIN_FREE || 10 * 1024 * 1024 * 1024
);
const START_TIMEOUT_MS = 25 * 1000;

let ffmpegChecked: boolean | null = null;
let transcodeBaseDir: string | null = null;

/** ffmpeg 是否可用（缓存检测结果） */
export function isFfmpegAvailable(): boolean {
  if (ffmpegChecked !== null) return ffmpegChecked;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegChecked = r.status === 0;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

/** 转码工作目录：优先环境变量，其次 /app/video-cache，最后系统临时目录 */
export function getTranscodeBaseDir(): string {
  if (transcodeBaseDir) return transcodeBaseDir;
  const candidates = [
    process.env.EMBY_TRANSCODE_DIR,
    '/app/video-cache/emby-transcode',
    path.join(os.tmpdir(), 'emby-transcode'),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      transcodeBaseDir = dir;
      return dir;
    } catch {
      // 换下一个候选
    }
  }
  // 兜底（理论上到不了）
  transcodeBaseDir = candidates[candidates.length - 1];
  fs.mkdirSync(transcodeBaseDir, { recursive: true });
  return transcodeBaseDir;
}

/** 会话 key：同一片源 + 同一音轨复用 */
export function buildSessionKey(
  embyKey: string | undefined,
  itemId: string,
  audioPos: number
): string {
  return `${embyKey || 'default'}:${itemId}:a${audioPos}`;
}

/**
 * 把 Emby 音轨 index 换算成 ffmpeg 的 0:a:N（音频流相对序号）
 * tracks: getAudioStreams() 返回的音轨列表（按 index 排序）
 */
export function toFfmpegAudioPos(
  tracks: Array<{ index: number; isDefault?: boolean }>,
  embyAudioIndex?: number
): number {
  const sorted = [...tracks].sort((a, b) => a.index - b.index);
  if (sorted.length === 0) return 0;
  if (typeof embyAudioIndex === 'number') {
    const pos = sorted.findIndex((t) => t.index === embyAudioIndex);
    if (pos >= 0) return pos;
  }
  const defPos = sorted.findIndex((t) => t.isDefault);
  return defPos >= 0 ? defPos : 0;
}

/**
 * 重写 playlist 中的分片相对路径为可访问的 URL 前缀
 * 只处理形如 seg00001.ts 的行，防止路径穿越
 */
export function rewritePlaylistUrls(
  playlistText: string,
  segUrlPrefix: string
): string {
  return playlistText
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (/^seg\d+\.ts$/i.test(t)) {
        return `${segUrlPrefix}/${t}`;
      }
      return line;
    })
    .join('\n');
}

/** 分片文件名合法性校验（防路径穿越） */
export function isValidSegmentFile(file: string): boolean {
  return /^seg\d+\.ts$/i.test(file);
}

function freeBytes(dir: string): number {
  try {
    // 用 statfs 估算（Node 18.15+ 支持 fs.statfsSync）
    const st = (fs as unknown as { statfsSync: (p: string) => { bavail: number; bsize: number } }).statfsSync(dir);
    return st.bavail * st.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // 取不到就放行
  }
}

function destroySession(key: string, reason: string): void {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  try {
    if (s.proc && !s.proc.killed) s.proc.kill('SIGKILL');
  } catch {
    // ignore
  }
  // 延迟删除分片目录，避免正在读取的请求 404
  setTimeout(() => {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 5000).unref?.();
  console.log(`[EmbyTranscode] 会话回收 (${reason}):`, s.id);
}

/** 空闲会话回收 */
function sweep(): void {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (now - s.lastAccess > IDLE_TIMEOUT_MS) {
      destroySession(key, 'idle超时');
    }
  }
}

// 模块加载时启动回收定时器（每个 Node 进程一份）
{
  const timer = setInterval(sweep, 60 * 1000);
  (timer as unknown as { unref?: () => void }).unref?.();
  const killAll = () => {
    for (const key of [...sessions.keys()]) destroySession(key, '进程退出');
  };
  process.once('exit', killAll);
  process.once('SIGTERM', killAll);
}

export interface StartSessionOptions {
  embyKey?: string;
  itemId: string;
  audioPos: number;
  /** Emby 直链（ffmpeg 直接拉流） */
  inputUrl: string;
}

/**
 * 获取或创建转码会话。成功返回会话（含分片目录）；
 * 失败抛 TranscodeError。
 */
export async function getOrStartSession(
  opts: StartSessionOptions
): Promise<TranscodeSession> {
  if (!isFfmpegAvailable()) {
    throw new TranscodeError('NO_FFMPEG', '服务器未安装 ffmpeg，无法进行音频转码');
  }

  const key = buildSessionKey(opts.embyKey, opts.itemId, opts.audioPos);
  const existing = sessions.get(key);
  if (existing) {
    const playlistExists =
      !existing.failed &&
      fs.existsSync(path.join(existing.dir, 'playlist.m3u8'));
    if (playlistExists) {
      // 复用：ffmpeg 运行中，或已转码完成（playlist 完整可继续服务）
      existing.lastAccess = Date.now();
      return existing;
    }
    // 已失败/无 playlist 的会话先清理再重建
    destroySession(key, '重建');
  }

  if (sessions.size >= MAX_SESSIONS) {
    throw new TranscodeError(
      'TOO_MANY',
      `转码任务已满（${MAX_SESSIONS} 路），请稍后再试`
    );
  }

  const baseDir = getTranscodeBaseDir();
  if (freeBytes(baseDir) < MIN_FREE_BYTES) {
    throw new TranscodeError('NO_DISK', '服务器磁盘空间不足，无法开始转码');
  }

  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const playlistPath = path.join(dir, 'playlist.m3u8');

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.inputUrl,
    '-map',
    '0:v:0',
    '-map',
    `0:a:${opts.audioPos}`,
    '-c:v',
    'copy', // 视频不转码，直接复制
    '-c:a',
    'aac', // 音频转 AAC（浏览器通用）
    '-b:a',
    '320k',
    '-f',
    'hls',
    '-hls_time',
    '6',
    '-hls_list_size',
    '0', // 全量保留，支持任意 seek
    '-hls_segment_filename',
    path.join(dir, 'seg%05d.ts'),
    playlistPath,
  ];

  console.log('[EmbyTranscode] 启动 ffmpeg:', {
    id,
    itemId: opts.itemId,
    audioPos: opts.audioPos,
  });

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  proc.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  const session: TranscodeSession = {
    key,
    id,
    dir,
    proc,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    failed: false,
  };
  sessions.set(key, session);

  // 同一片源切换了音轨：回收旧音轨的会话，避免 ffmpeg 堆积
  const siblingPrefix = `${opts.embyKey || 'default'}:${opts.itemId}:a`;
  for (const k of [...sessions.keys()]) {
    if (k !== key && k.startsWith(siblingPrefix)) {
      destroySession(k, '同片源切换音轨');
    }
  }

  proc.on('exit', (code, signal) => {
    // ffmpeg 正常跑完（整片转码完成）也算退出：保留分片供继续观看
    const playlistExists = fs.existsSync(playlistPath);
    console.log('[EmbyTranscode] ffmpeg 退出:', {
      id,
      code,
      signal,
      playlistExists,
    });
    session.proc = null;
    if (!playlistExists) {
      session.failed = true;
      session.failReason = stderrTail || `ffmpeg 异常退出 (code=${code})`;
    }
    // 即使正常结束也刷新 lastAccess，让空闲回收接管
    session.lastAccess = Date.now();
  });
  proc.on('error', (err) => {
    console.error('[EmbyTranscode] ffmpeg 启动失败:', err.message);
    session.failed = true;
    session.failReason = err.message;
  });

  // 等待 playlist 生成（ffmpeg 探测 + 首个分片）
  const start = Date.now();
  while (Date.now() - start < START_TIMEOUT_MS) {
    if (session.failed) {
      destroySession(key, '启动失败');
      throw new TranscodeError(
        'FFMPEG_EXIT',
        `转码启动失败：${session.failReason || '未知错误'}`
      );
    }
    if (fs.existsSync(playlistPath)) {
      return session;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  destroySession(key, '启动超时');
  throw new TranscodeError(
    'START_TIMEOUT',
    `转码启动超时（${START_TIMEOUT_MS / 1000}s 内未生成播放列表）${stderrTail ? '：' + stderrTail.slice(-300) : ''}`
  );
}

/** 按会话 id 查找（供分片路由使用） */
export function getSessionById(id: string): TranscodeSession | undefined {
  for (const s of sessions.values()) {
    if (s.id === id) return s;
  }
  return undefined;
}

/** 刷新会话活跃时间 */
export function touchSessionById(id: string): void {
  const s = getSessionById(id);
  if (s) s.lastAccess = Date.now();
}
