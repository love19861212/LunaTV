# LunaTV Enhanced 6.6.3 部署小结 — 2026-07-12

> 给官人后续慢慢研究、扩展维护用的速查单。
> 公网：`https://moontv.54321.asia`（CF Tunnel → `lunatv` 容器 @ 43.133.40.4 :3003）

---

## 1. 当前在线状态

| 资源 | 状态 |
|---|---|
| 公网 `moontv.54321.asia` | ✅ 6.6.3 |
| CF tunnel `moontv-prod` (`a7490459-3701-4c94-8b66-0226e1f99a6e`) | healthy，4 边缘 sin15/16/17/22 |
| tunnel ingress | `moontv.54321.asia → http://localhost:3003`，`/api/server-config` 返 `Version=6.6.3` |
| 容器 `lunatv` | `lunatv-enhanced:6.6.3`，`127.0.0.1:3003→3000`，接正式 Kvrocks，`--restart=unless-stopped` |
| 数据库 `moontv-kvrocks` | `apache/kvrocks` 正式库（健康） |
| 测试库 `moontv-kvrocks-test`（127.0.0.1:6667） | 仍保留待清（不在线时不影响） |
| 5.7.1 旧版镜像 / 容器 | 已全部清理（5.7.1-test / 5.7.1-linkfix / 5.7.1-bgfix 均删） |
| 5.7.1 tar.gz 备份 | 已删（仅留 inspect json，便于排错） |
| **回滚位** `moontv-core` | 旧 MoonTV 14.2.35 容器仍跑 `127.0.0.1:3001`，不是 LunaTV |

---

## 2. 代码 & 配置位置

VPS：`43.133.40.4` / `VM-12-4-debian`

| 项目 | 路径 |
|---|---|
| 源码（fork） | `/root/LunaTV-v6` —— 这是从 `love19861212/LunaTV` 拉来的，v6.6.3 主分支 |
| 早期 fork（5.7.1） | `/root/LunaTV_tools_tv` —— 已被覆盖升级，目录在但已被新版取代 |
| 5.7.1 backup | `/root/moontv-upgrade-66-backup-20260712-000100/`（仅 2 份 inspect json） |
| CF token | `/root/ziwei-doushu/.env.cfsync`（有 `CF_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID / CF_TUNNEL_ID`） |

源码相对 SzeMeng76/LunaTV 的本地修改（已 commit 到 fork）：

- `src/lib/version_check.ts`：`VERSION.txt` 来源改为
  `https://raw.githubusercontent.com/love19861212/LunaTV/refs/heads/main/VERSION.txt`
- `src/components/VersionPanel.tsx`：
  - `CHANGELOG` 来源同上 fork
  - “前往仓库”按钮指向
    `https://github.com/love19861212/LunaTV`
- `src/components/VersionPanel.tsx`（同文件）：`SzeMeng76/LunaTV` → `love19861212/LunaTV`
- README 里 XWF8188 / Selene 链接保留不动（外部真仓，非强相关）

---

## 3. 关键 Docker 信息

容器（按状态列出）：

```text
lunatv                lunatv-enhanced:6.6.3   127.0.0.1:3003->3000   running
moontv-core           moontv-core-fixed:14.2.35 127.0.0.1:3001->3000   running  ← 回滚位
moontv-kvrocks        apache/kvrocks           6666/tcp               running  ← 正式库
moontv-kvrocks-test   apache/kvrocks           127.0.0.1:6667->6666   running  ← 测试库副本
lotus-mcp-service     mcp-service_lotus-mcp    127.0.0.1:3000->3000   running  ← 不要动
```

网络：

```text
moontv-prod-switch-net  ← 把 moontv-kvrocks 和 lunatv 接在同一二层，KVROCKS_URL 才能 redis://moontv-kvrocks:6666
```

镜像清单（只剩生产版）：

```text
lunatv-enhanced:6.6.3   ← 现役
```

备份文件（小，仅 32KB）：

```text
/root/moontv-upgrade-66-backup-20260712-000100/moontv-core.inspect.json
/root/moontv-upgrade-66-backup-20260712-000100/moontv-kvrocks.inspect.json
```

---

## 4. lunatv 容器启动参数（重建时直接复用）

```bash
USERNAME_ENV=$(docker inspect moontv-core \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^USERNAME=' | head -1)
PASSWORD_ENV=$(docker inspect moontv-core \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^PASSWORD=' | head -1)

docker rm -f lunatv 2>/dev/null || true
docker network create moontv-prod-switch-net 2>/dev/null || true
docker network connect moontv-prod-switch-net moontv-kvrocks 2>/dev/null || true

docker run -d --name lunatv --restart=unless-stopped \
  --network moontv-prod-switch-net \
  -p 127.0.0.1:3003:3000 \
  -e "$USERNAME_ENV" -e "$PASSWORD_ENV" \
  -e NEXT_PUBLIC_STORAGE_TYPE=kvrocks \
  -e KVROCKS_URL=redis://moontv-kvrocks:6666 \
  -e NEXT_PUBLIC_SITE_NAME=MoonTV \
  -e NEXT_PUBLIC_DOUBAN_PROXY_TYPE=direct \
  -e NEXT_PUBLIC_FLUID_SEARCH=true \
  lunatv-enhanced:6.6.3
```

如果想加内置代理 / 豆瓣代理之类：

- `NEXT_PUBLIC_DOUBAN_PROXY_TYPE=` `direct | cmliussss-cdn-tencent | ...`
- `NEXT_PUBLIC_DOUBAN_PROXY=` 代理地址
- `NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE=` / `NEXT_PUBLIC_DOUBAN_IMAGE_PROXY=`
- `NEXT_PUBLIC_BANGUMI_API_TYPE=` / `NEXT_PUBLIC_BANGUMI_API_PROXY=`
- `NEXT_PUBLIC_BANGUMI_IMAGE_PROXY_TYPE=` / `NEXT_PUBLIC_BANGUMI_IMAGE_PROXY=`
- `NEXT_PUBLIC_CORSAPI_URL=`
- `NEXT_PUBLIC_DISABLE_YELLOW_FILTER=true`
- `NEXT_PUBLIC_FLUID_SEARCH=false` 关流式搜索

改完后只要 `docker rm -f lunatv && docker run ...` 即可，Kvrocks 数据不会丢。

---

## 5. 重建镜像（升级到新版本时用）

```bash
cd /root/LunaTV-v6
git pull origin main
docker build -t lunatv-enhanced:<new-version> .
docker rm -f lunatv
docker run -d --name lunatv ... lunatv-enhanced:<new-version>
# 验证
curl -fsS http://127.0.0.1:3003/api/server-config | python3 -m json.tool
```

切公网（同步把 CF tunnel 改 `service` 到新端口）：

```bash
source /root/ziwei-doushu/.env.cfsync
TUNNEL_ID=a7490459-3701-4c94-8b66-0226e1f99a6e
python3 - <<'PY'
import json, sys, os, subprocess
token = os.environ['CF_API_TOKEN']
acct = os.environ['CF_ACCOUNT_ID']
tunnel = os.environ.get('CF_TUNNEL_ID') or 'a7490459-3701-4c94-8b66-0226e1f99a6e'
# 备份
subprocess.run(['curl','-sS','-H',f'Authorization: Bearer {token}',
  f'https://api.cloudflare.com/client/v4/accounts/{acct}/cfd_tunnel/{tunnel}/configurations',
  '-o','/tmp/cfg-before.json'])
# 改 service，例如把 3003 换成 3010
import json
data=json.load(open('/tmp/cfg-before.json'))
for r in data['result']['config']['ingress']:
    if r.get('hostname')=='moontv.54321.asia':
        r['service']='http://localhost:3010'
json.dump({'config':{'ingress':data['result']['config']['ingress']}},
          open('/tmp/cfg-new.json','w'))
PY

curl -X PUT -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/cfg-new.json \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations"
```

CF 上线变更后建议做 3 件：

1. `curl -fsS https://moontv.54321.asia/api/server-config` 看版本对；
2. 浏览器强刷 + 看一遍首页 / 豆瓣 / 短剧；
3. CF token 没有 zone DNS / firewall 权限，所以 WAF 规则读不了，但只要服务返 200 就正常。

---

## 6. 回滚预案（务必保留 1 周再删）

### A. 5.7.1 / 6.6.3 之间回滚

只有 6.6.3 在线可以。6.6.3 自身不稳：

1. `docker rm -f lunatv`（保留镜像 tag）
2. `docker run -d --name lunatv --network moontv-prod-switch-net -p 127.0.0.1:3003:3000 ... lunatv-enhanced:6.6.1`（用更早 tag，需提前 pull）
3. 同步把 CF tunnel 的 service 改到新端口
4. 公网 `curl https://moontv.54321.asia/api/server-config` 验证

### B. 完全退回旧 MoonTV 14.2.35

旧容器 `moontv-core` 还在 3001：

```bash
source /root/ziwei-doushu/.env.cfsync
TUNNEL_ID=a7490459-3701-4c94-8b66-0226e1f99a6e
# 把 service 改回 3001
python3 - <<'PY'
import json
data=json.load(open('/tmp/cfg-before.json'))  # 之前的快照
for r in data['result']['config']['ingress']:
    if r.get('hostname')=='moontv.54321.asia':
        r['service']='http://localhost:3001'
json.dump({'config':{'ingress':data['result']['config']['ingress']}},
          open('/tmp/cfg-rollback.json','w'))
PY
curl -X PUT -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/cfg-rollback.json \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations"
```

⚠️ **注意**：14.2.35 是另一个版本（原生 MoonTV），和 LunaTV 数据库结构不同（用 sqlite 后端）。一旦改过去：
- 不能简单写回 6.6.3 而不重新初始化
- 看板上数据会丢
- 只在紧急“修一晚上再说”时用

### C. CF 配置快照

最新一次的 CF 配置（v6.6.3 部署后）就是：

```json
{
  "config": {
    "ingress": [
      {"service":"http://localhost:3003","hostname":"moontv.54321.asia"},
      {"service":"http_status:404"}
    ]
  }
}
```

---

## 7. 已知事实 & 当前限制

- **当前部署版本**：`moontv@6.6.3`。
- **更新检查已经指向** `https://raw.githubusercontent.com/love19861212/LunaTV/refs/heads/{VERSION.txt,CHANGELOG}`。要看到新版通知，需要先把 fork 同步 SzeMeng76。
- **短剧**：默认主 API `https://api.r2afosne.dpdns.org` 在本机和公网都“解析失败”，所以短剧频道会空白。备用 API 是 `/api/v1/drama/...` 协议（LunaTV Enhanced 6.6.3 默认主源是 `https://tyyszyapi.com/api.php/provide/vod`，已写进代码）。建议官人研究时先开短剧频道 + 在后台填备用 API。
- **WAF / Rate Limit**：CF tunnel 上没有强 WAF。CF token 是 tunnel-write 权限，没有 zone-level 读 WAF 配置的权限。
- **认证**：单一 admin 账号 `USERNAME / PASSWORD`（在 env），多用户注册功能在登录页可见，但需要检查 `NEXT_PUBLIC_STORAGE_TYPE=kvrocks` + 实际 Kvrocks 用户表是否启用。
- **缓存**：CDN 默认 DYNAMIC，静态资源走 cf-cache；不强制清缓存也行。

---

## 8. 公网验证 cheat sheet

```bash
# 1. Tunnel health
curl -sS -m 15 -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['result']['status'])"

# 2. Tunnel ingress
curl -sS -m 15 -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$CF_TUNNEL_ID/configurations" \
  | python3 -c "import json,sys;[print(r) for r in json.load(sys.stdin)['result']['config']['ingress']]"

# 3. Public version
curl -fsS https://moontv.54321.asia/api/server-config | python3 -m json.tool

# 4. Uptime
for i in 1 2 3 4 5 6; do
  curl -sS -o /dev/null -w "t=%{time_total}s code=%{http_code}\n" \
    https://moontv.54321.asia/login?redirect=%2F
done

# 5. Skip UA bypass
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H 'User-Agent: GoldenLotus-Test/1.0' \
  https://moontv.54321.asia/login?redirect=%2F

# 6. Backstage config
USERNAME_ENV=$(docker inspect moontv-core --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^USERNAME=')
PASSWORD_ENV=$(docker inspect moontv-core --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^PASSWORD=')
USER=$(echo "$USERNAME_ENV" | cut -d= -f2-)
PASS=$(echo "$PASSWORD_ENV" | cut -d= -f2-)
rm -f /tmp/ck.txt
curl -sS -c /tmp/ck.txt -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  -o /dev/null -w "login=%{http_code}\n" \
  http://127.0.0.1:3003/api/login
curl -sS -b /tmp/ck.txt -o /dev/null -w "config=%{http_code}\n" \
  http://127.0.0.1:3003/api/admin/config
```

---

## 9. 一句话恢复清单（如果你将来直接打开就报错）

```bash
# 1. 看 lunatv 是否还在
docker ps --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'

# 2. 不在就起一个
bash 见 §4

# 3. 公网 200 但版对不上：检查 CF ingress
bash 见 §5

# 4. 都不行：切到旧 14.2.35
bash 见 §6-B
```
