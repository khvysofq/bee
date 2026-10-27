// 本地样本分析器（不联网）：解码 HTML，输出标题/字符集/行容器/日期/品名/链接摘要
import { readFileSync, readdirSync } from 'node:fs';

const SAMPLES = '/root/.openclaw/workspace/main/bee/recon/fengj-samples';
const files = process.argv.slice(2);

function decode(buf) {
  const meta = buf.toString('latin1').match(/charset=["'>\s]*([a-zA-Z0-9-]+)/);
  const cs = (meta?.[1] || '').toLowerCase();
  const names = cs.includes('gb') ? ['gbk', 'utf-8'] : cs.includes('utf') ? ['utf-8', 'gbk'] : ['utf-8', 'gbk'];
  for (const n of names) {
    try {
      const t = new TextDecoder(n, { fatal: true }).decode(buf);
      return { text: t, enc: n };
    } catch {}
  }
  return { text: new TextDecoder('utf-8').decode(buf), enc: 'utf8-lossy' };
}

function strip(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

for (const f of files) {
  const path = f.startsWith('/') ? f : `${SAMPLES}/${f}`;
  const buf = readFileSync(path);
  const { text, enc } = decode(buf);
  const title = strip(text.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
  console.log(`\n=== ${path.split('/').pop()} bytes=${buf.length} enc=${enc} title="${title}"`);

  // 日期分布
  const dates = [...text.matchAll(/20\d\d-\d\d-\d\d/g)].map((m) => m[0]).sort();
  if (dates.length) {
    const uniq = [...new Set(dates)];
    console.log(`dates: n=${dates.length} uniq=${uniq.length} range=${uniq[0]}..${uniq.at(-1)}`);
  } else {
    const cn = [...new Set([...text.matchAll(/(\d{1,2})月(\d{1,2})日/g)].map((m) => m[0]))];
    console.log(`dates: ascii-none; 中文日期=${cn.slice(0, 5).join(',')}${cn.length > 5 ? '…' : ''}`);
  }

  // 候选行容器
  const counts = {};
  for (const m of text.matchAll(/<([tduli])\b[^>]*class="([^"]*)"/gi)) {
    counts[m[2]] = (counts[m[2]] || 0) + 1;
  }
  const top = Object.entries(counts).filter(([k]) => /price|list|roll|hang|lie|tr|td|table|name|city|sheng/i.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('row-classes:', top.map(([k, v]) => `${k}=${v}`).join(' | ') || '(none)');

  // 表格数
  console.log('tables:', (text.match(/<table/gi) || []).length, 'price-ish divs:', (text.match(/class="[^"]*(price|baojia|quote)[^"]*"/gi) || []).length);

  // 链接里的行情/历史入口
  const links = [...new Set([...text.matchAll(/(?:href|src|url)\s*[=(]\s*['"]([^'"]+)['"]/gi)].map((m) => m[1]))];
  const hist = links.filter((l) => /chart|price|baojia|his|date|zoushi|futures|day|week|month|newslist|more|list\/|p\d+|y\d+m\d|area|province/i.test(l)).slice(0, 30);
  console.log('hist-ish links:');
  for (const l of hist) console.log('   ', l);
}
