// 本地检查：每页 roll_list 行数、登录遮罩次数、日期范围、样本行
import { readFileSync } from 'node:fs';

const SAMPLES = '/root/.openclaw/workspace/main/bee/recon/fengj-samples/';
for (const name of process.argv.slice(2)) {
  const buf = readFileSync(SAMPLES + name);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('gbk').decode(buf); }
  const roll = [...text.matchAll(/<ul[^>]*class="[^"]*roll_list[^"]*"[\s\S]*?<\/ul>/g)];
  let liCount = 0;
  for (const r of roll) liCount += (r[0].match(/<li/g) || []).length;
  const scroll = (text.match(/id="scrollText"/g) || []).length;
  const masked = (text.match(/未登录/g) || []).length;
  const dates = [...new Set([...text.matchAll(/20\d\d-\d{1,2}-\d{1,2}/g)].map((m) => m[0]))].sort();
  const md = [...text.matchAll(/\b1[0-2]-\d{2}\b/g)].length;
  const header = text.match(/roll_list_name[\s\S]{0,200}/)?.[0].replace(/<[^>]+>/g, '|').slice(0, 120);
  console.log(`== ${name}: rollUl=${roll.length} li=${liCount} scrollText=${scroll} masked=${masked} dates=${dates[0] || '-'}..${dates.at(-1) || '-'} n=${dates.length} mmdd=${md}`);
  if (header) console.log('   header:', header.replace(/\s+/g, ' '));
}
