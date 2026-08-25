/*
 * context_probe.mjs — 给「某个词为什么会被报错」找证据
 *
 * 为什么需要它:我一度把 api/html/env/dir/pre 都称作「URL 泄漏的碎片」并塞进技术词表。
 * 但那是推断 —— https 显然是 URL 泄漏,而小写 api/css/png 完全可能是正文里合法的技术写法。
 * 两种情况处置**完全相反**:
 *   泄漏  → 要修 stripNonProse 的根因,不该进词表
 *   合法术语 → 就该留在词表里,那不是掩盖
 * 所以先看上下文,再决定。
 *
 * 用法:  node context_probe.mjs [word1,word2,...]
 */
import { visibleText } from './pipeline.mjs';

const TARGETS = (process.argv[2] ||
  'api,apis,html,iso,env,pre,dir,css,jpg,png,https,mit,lifecycle,esc,utf,koi')
  .split(',').map(s => s.trim()).filter(Boolean);

const PAGES = [
  ['MDN',    'https://developer.mozilla.org/en-US/docs/Web/API/fetch'],
  ['VSCode', 'https://code.visualstudio.com/api/references/vscode-api'],
  ['knip',   'https://knip.dev/typescript/unused-exports'],
  ['ChromeExt','https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns'],
];

const MAX_PER_WORD = 3;

const found = new Map();          // word -> [{page, ctx}]
const rawAttrHits = new Map();    // word -> 在 href/src 属性里出现的次数(判泄漏用)

for (const [name, url] of PAGES) {
  let html;
  try {
    const r = await fetch(url, { headers: {
      'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' } });
    if (!r.ok) { console.log(`!! ${name} HTTP ${r.status}`); continue; }
    html = await r.text();
  } catch (e) { console.log(`!! ${name} ${e.message}`); continue; }

  // ① 在「实际送检的文本」里找上下文 —— 这才是 pipeline 看到的东西
  const text = visibleText(html);
  for (const w of TARGETS) {
    const re = new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`, 'gi');
    let m;
    while ((m = re.exec(text))) {
      const arr = found.get(w) || [];
      if (arr.length >= MAX_PER_WORD) break;
      arr.push({ page: name,
        ctx: text.slice(Math.max(0, m.index - 46), m.index + w.length + 46).trim() });
      found.set(w, arr);
    }
  }

  // ② 统计它在 href/src 这类属性里出现多少次 —— 如果 ① 里有而这里也多,说明可能是泄漏
  for (const w of TARGETS) {
    const re = new RegExp(`(?:href|src|content)\\s*=\\s*["'][^"']*(?<![A-Za-z])${w}(?![A-Za-z])[^"']*["']`, 'gi');
    const n = (html.match(re) || []).length;
    if (n) rawAttrHits.set(w, (rawAttrHits.get(w) || 0) + n);
  }
}

console.log('=== context_probe:被报错词的实际出处 ===\n');
for (const w of TARGETS) {
  const arr = found.get(w) || [];
  const attr = rawAttrHits.get(w) || 0;
  console.log(`── ${w}   送检文本中出现 ${arr.length}${arr.length >= MAX_PER_WORD ? '+' : ''} 次` +
              `   |  href/src 属性中出现 ${attr} 次`);
  if (!arr.length) { console.log('     (送检文本里没出现 —— 说明它已被剥掉或不在这些页上)'); }
  for (const { page, ctx } of arr) console.log(`     [${page}] …${ctx}…`);
  console.log('');
}
console.log('判读方法:');
console.log('  · 上下文是正常英文句子 → **合法技术术语**,留在 TECH 词表里是对的');
console.log('  · 上下文是一串路径/域名/参数残渣 → **URL 泄漏**,该修 stripNonProse,不该进词表');
