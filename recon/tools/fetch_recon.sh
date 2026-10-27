#!/usr/bin/env bash
# fengj 受控勘查抓取器。规则：
# - 全局预算 45 次 HTTP 请求（计数文件持久化，超限直接退出）
# - 每次请求前 sleep 随机 8–20 秒
# - 诚实 UA；默认不带 Referer / cookie（测“是否需要”）
# - 567/429 -> 该 host 记为 blocked，并从后续队列中剔除同 host 请求
# 用法: fetch_recon.sh <spec-file>
#   spec 每行: name<TAB>url[<TAB>referer]
set -u
ROOT=/root/.openclaw/workspace/main/bee/recon
SAMPLES=$ROOT/fengj-samples
LOG=$SAMPLES/fetch-log.tsv
CNT=$SAMPLES/.reqcount
UA='bee-monitor/0.1 (+price monitoring; contact: owner)'
BUDGET=45
mkdir -p "$SAMPLES"
touch "$LOG" "$CNT"
count=$(cat "$CNT" 2>/dev/null || echo 0)
blocked_hosts=""

if [ ! -f "$LOG" ]; then printf 'ts\thttp\tbytes\tsec\thost\tpath\tfile\n' > "$LOG"; fi

while IFS=$'\t' read -r name url ref; do
  [ -z "${name:-}" ] && continue
  case "$name" in \#*) continue;; esac
  host=$(printf '%s' "$url" | sed -E 's#^[a-z]+://([^/]+).*#\1#')
  if printf '%s' "$blocked_hosts" | grep -qw "$host"; then
    echo "SKIP-BLOCKED $name $url"
    continue
  fi
  if [ "$count" -ge "$BUDGET" ]; then
    echo "BUDGET-EXHAUSTED at $count; refusing $name"
    exit 3
  fi
  delay=$(python3 -c "import random;print(random.uniform(8,20))")
  sleep "$delay"
  out="$SAMPLES/$name.html"
  hdr="$SAMPLES/$name.hdr"
  res=$(curl -sS -m 30 -A "$UA" ${ref:+-H "Referer: $ref"} -o "$out" -D "$hdr" -w '%{http_code}\t%{size_download}\t%{time_total}' "$url" 2>"$SAMPLES/$name.err") || {
    echo "CURL-FAIL $name $url : $(cat "$SAMPLES/$name.err")"
    count=$((count+1)); echo "$count" > "$CNT"
    continue
  }
  code=$(printf '%s' "$res" | cut -f1)
  bytes=$(printf '%s' "$res" | cut -f2)
  sec=$(printf '%s' "$res" | cut -f3)
  count=$((count+1)); echo "$count" > "$CNT"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%FT%T)" "$code" "$bytes" "$sec" "$host" "$url" "$name" >> "$LOG"
  echo "REQ#$count $code ${bytes}B ${sec}s $host $name"
  if [ "$code" = "567" ] || [ "$code" = "429" ]; then
    echo "BLOCKED host=$host (code=$code) -> removing sample, halting this host"
    blocked_hosts="$blocked_hosts $host"
    mv "$out" "$SAMPLES/$name.blocked-$code.html" 2>/dev/null
  elif grep -qiE 'captcha|验证码|请开启JS|安全检测|访问过于频繁' "$out" 2>/dev/null; then
    echo "CHALLENGE-PAGE $name (code=$code) -> marking host $host blocked"
    blocked_hosts="$blocked_hosts $host"
    mv "$out" "$SAMPLES/$name.challenge.html" 2>/dev/null
  fi
done < "$1"
echo "TOTAL-REQUESTS=$count"
