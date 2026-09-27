/* eslint-disable no-console */
import { randomBytes } from 'crypto';

/**
 * iPlay 播放令牌（内存存储，单实例）
 * 用途：前端用真实 Emby 播放地址换取令牌，深链里只放令牌地址，
 * 不暴露 Emby 服务器地址和 api_key。令牌 5 分钟过期，过期前可重复兑换
 * （播放器播流时会发多个 HTTP 请求：取元数据、seek、重试，一次性令牌会断流）。
 */

/**
 * 兑换令牌：有效期内返回真实地址（可重复兑换）；
 * 不存在或过期返回 null（过期自动清理）。
 */
export function redeemIPlayToken(token: string): string | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return entry.url;
}

interface TokenEntry {
  url: string;
  expiresAt: number;
}

const tokens = new Map<string, TokenEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 分钟

function cleanup() {
  const now = Date.now();
  for (const [k, v] of tokens) {
    if (now > v.expiresAt) tokens.delete(k);
  }
  if (tokens.size > 1000) {
    // 兜底：防止内存无限增长，清空最旧的一半
    const keys = Array.from(tokens.keys()).slice(0, 500);
    keys.forEach((k) => tokens.delete(k));
  }
}

/** 签发令牌，返回 token */
export function createIPlayToken(url: string): string {
  cleanup();
  const token = randomBytes(16).toString('hex');
  tokens.set(token, { url, expiresAt: Date.now() + TTL_MS });
  return token;
}
