/*
 * fp_probe.mjs — false-positive rate of a local-dictionary spell checker
 *                on real English technical documentation.
 *
 * Why this has to be measured rather than assumed: for a page-wide spell
 * checker, the false-positive rate is the number that decides whether the
 * tool is usable at all. A checker that underlines 5% of a technical
 * document is not a checker, it is a red wall you learn to ignore.
 *
 * All filtering logic comes from ./pipeline.mjs (single source of truth,
 * shared with recall_probe.mjs — and with the shipped extension).
 *
 * Usage:  node fp_probe.mjs
 */
import nspellPkg from 'nspell';
import dictionary from 'dictionary-en';
import { visibleText, checkText, pageLang, isEnglish } from './pipeline.mjs';

const nspell = nspellPkg.default || nspellPkg;

const PAGES = [
  ['MDN fetch API',      'https://developer.mozilla.org/en-US/docs/Web/API/fetch'],
  ['VS Code API ref',    'https://code.visualstudio.com/api/references/vscode-api'],
  ['knip unused-exports','https://knip.dev/typescript/unused-exports'],
  ['Chrome ext 匹配模式', 'https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns'],
];

async function main() {
  const spell = nspell(dictionary);
  console.log('=== fp_probe:本地词典误报实测 ===');
  console.log('nspell + dictionary-en(SCOWL en_US),过滤逻辑来自 pipeline.mjs\n');

  const flagged = new Map();
  const skipStats = {};
  let totalWords = 0, checkedWords = 0, pagesOk = 0;

  for (const [name, url] of PAGES) {
    let html;
    try {
      const r = await fetch(url, { headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en-US,en;q=0.9'   // 不加这条,Chrome 文档页会被服务成德语
      } });
      if (!r.ok) { console.log(`  !! ${name}: HTTP ${r.status}`); continue; }
      html = await r.text();
    } catch (e) { console.log(`  !! ${name}: ${e.message}`); continue; }

    const lang = pageLang(html);
    if (!isEnglish(lang)) {
      console.log(`  ${name.padEnd(22)} ⏭ 跳过:页面 lang="${lang}" 非英语(语言门生效)`);
      continue;
    }

    const r2 = checkText(visibleText(html), spell);
    for (const w of r2.flagged) flagged.set(w, (flagged.get(w) || 0) + 1);
    for (const [k, v] of Object.entries(r2.skipStats)) skipStats[k] = (skipStats[k] || 0) + v;
    totalWords += r2.total; checkedWords += r2.checked; pagesOk++;

    const rate = r2.checked ? (100 * r2.flagged.length / r2.checked) : 0;
    console.log(`  ${name.padEnd(22)} 文本词 ${String(r2.total).padStart(6)}` +
      ` | 送检 ${String(r2.checked).padStart(5)} | 报错 ${String(r2.flagged.length).padStart(4)}` +
      ` | ${rate.toFixed(2)}%`);
  }

  if (!pagesOk) { console.log('\n!! 一个页面都没拉到,无法出数'); return; }

  const totalFlagged = [...flagged.values()].reduce((a, b) => a + b, 0);
  const rate = checkedWords ? (100 * totalFlagged / checkedWords) : 0;
  console.log('\n--- 汇总 ---');
  console.log(`  页面 ${pagesOk}/${PAGES.length}  文本词 ${totalWords}  送检 ${checkedWords}` +
    `  报错 ${totalFlagged}  =  ${rate.toFixed(2)}%`);
  console.log('  跳过规则命中:', Object.entries(skipStats)
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));

  const top = [...flagged.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n--- 被报错的词 top 40(共 ${top.length} 个唯一词)---`);
  const cols = top.slice(0, 40).map(([w, c]) => `${w}(${c})`);
  for (let i = 0; i < cols.length; i += 4) {
    console.log('   ' + cols.slice(i, i + 4).map(s => s.padEnd(24)).join(''));
  }

  console.log('\n--- 判定线 ---');
  if (rate <= 0.5) console.log(`  ✅ ${rate.toFixed(2)}% —— 可接受,不会淹没真错字。`);
  else if (rate <= 2) console.log(`  ⚠️ ${rate.toFixed(2)}% —— 偏高,必须再加白名单/词典补充。`);
  else console.log(`  🛑 ${rate.toFixed(2)}% —— too high to ship: at this rate the
     highlights are noise rather than signal.`);
}

main().catch(e => { console.error('!! 挂了:', e); process.exit(1); });
