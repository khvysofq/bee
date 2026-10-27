// fengj 受控勘查抓取器（node 版）。
// 规则：预算 45 次；每次前随机 sleep 8-20s；诚实 UA；567/429/验证码 -> 停该 host；只读 GET。
// 用法: node recon_fetch.mjs <spec-file>   spec 每行: name<TAB>url[<TAB>referer]，#开头为注释
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';

const ROOT = '/root/.openclaw/workspace/main/bee/recon';
const SAMPLES = `${ROOT}/fengj-samples`;
mkdirSync(SAMPLES, { recursive: true });
const LOG = `${SAMPLES}/fetch-log.tsv`;
const CNT = `${SAMPLES}/.reqcount`;
const UA = 'bee-monitor/0.1 (+price monitoring; contact: owner)';
const BUDGET = 45;
const CHALLENGE = /captcha|验证码|请开启JS|安全检测|访问过于频繁|滑动验证/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => 8000 + Math.random() * 12000; // 8-20s

let count = existsSync(CNT) ? parseInt(readFileSync(CNT, 'utf8').trim() || '0', 10) : 0;
if (!existsSync(LOG)) writeFileSync(LOG, 'ts\thttp\tbytes\tsec\thost\turl\tname\n');
const blockedHosts = new Set(
  existsSync(`${SAMPLES}/blocked-hosts.txt`)
    ? readFileSync(`${SAMPLES}/blocked-hosts.txt`, 'utf8').split('\n').filter(Boolean)
    : [],
);

const spec = readFileSync(process.argv[2], 'utf8').split('\n');
for (const line of spec) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [name, url, referer] = line.split('\t');
  const host = new URL(url).host;
  if (blockedHosts.has(host)) {
    console.log(`SKIP-BLOCKED ${name} ${url}`);
    continue;
  }
  if (count >= BUDGET) {
    console.log(`BUDGET-EXHAUSTED at ${count}; refusing ${name}`);
    process.exit(3);
  }
  await sleep(jitter());
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: referer ? { 'User-Agent': UA, Referer: referer } : { 'User-Agent': UA },
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    count += 1;
    writeFileSync(CNT, String(count));
    appendFileSync(LOG, `${new Date().toISOString()}\t${res.status}\t${buf.length}\t${sec}\t${host}\t${url}\t${name}\n`);
    let suffix = '';
    const text = buf.toString('latin1');
    if (res.status === 567 || res.status === 429) {
      blockedHosts.add(host);
      writeFileSync(`${SAMPLES}/blocked-hosts.txt`, [...blockedHosts].join('\n') + '\n');
      suffix = ` BLOCKED-${res.status}`;
    } else if (CHALLENGE.test(text) || /<title>[^<]*(登录|注册)/i.test(text)) {
      blockedHosts.add(host);
      writeFileSync(`${SAMPLES}/blocked-hosts.txt`, [...blockedHosts].join('\n') + '\n');
      suffix = ' CHALLENGE';
    }
    writeFileSync(`${SAMPLES}/${name}${suffix || ''}.raw`, buf);
    console.log(`REQ#${count} ${res.status} ${buf.length}B ${sec}s ${host} ${name}${suffix}`);
    if (suffix) console.log(`  -> host ${host} now blocked, skipping its remaining URLs`);
  } catch (e) {
    count += 1;
    writeFileSync(CNT, String(count));
    appendFileSync(LOG, `${new Date().toISOString()}\tERROR\t0\t-\t${host}\t${url}\t${name}\n`);
    console.log(`REQ#${count} ERROR ${name} ${String(e).slice(0, 120)}`);
  }
}
console.log(`TOTAL-REQUESTS=${count}`);
