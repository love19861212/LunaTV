/* eslint-disable no-console */
import { randomBytes, createCipheriv, createHash } from 'crypto';

/**
 * iPlay 播放令牌（内存存储，单实例）
 * 用途：前端用真实 Emby 播放地址换取令牌，深链里只放令牌地址，
 * 不暴露 Emby 服务器地址和 api_key。令牌 5 分钟过期，过期前可重复兑换
 * （播放器播流时会发多个 HTTP 请求：取元数据、seek、重试，一次性令牌会断流）。
 *
 * v2（加密令牌）：用与 CF Worker 共享的密钥（IPLAY_TOKEN_SECRET）做 AES-256-GCM
 * 加密，Worker 直接解密拿到真实地址，无需再回跳 MoonTV 兑换，链路少一跳。
 * 密钥派生：SHA-256(secret)，与 Worker 端 WebCrypto 实现一致。
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

/** 从共享密钥派生 32 字节 AES 密钥（SHA-256），与 Worker 端一致 */
function deriveKey(): Buffer {
  const secret = process.env.IPLAY_TOKEN_SECRET || '';
  if (!secret) throw new Error('IPLAY_TOKEN_SECRET 未配置');
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * 签发加密令牌（v2）：payload = {"url","exp"}，AES-256-GCM 加密，
 * 输出 base64url(iv[12] + tag[16] + ciphertext)，可直接拼入 Worker ?iplay= 参数。
 * 5 分钟过期。Worker 用同一密钥解密，无需回跳 MoonTV。
 */
export function createEncryptedIPlayToken(url: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const payload = JSON.stringify({ url, exp: Date.now() + TTL_MS });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}
