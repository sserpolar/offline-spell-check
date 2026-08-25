/*
 * recall_probe.mjs — recall: inject known misspellings, count how many are caught.
 *
 * Why this is needed: fp_probe only proves the checker does not spam false
 * positives. Missing real errors is the other half of the problem, and
 * optimizing for one while ignoring the other just trades one failure for
 * the other.
 *
 * The most important output here is not a single percentage, but the split
 * of injected errors into two classes:
 *   1. Non-word errors (the result is not a real word) -> a dictionary CAN
 *      catch these -> recall here must be at or near 100%.
 *   2. Real-word errors (the result is itself a valid word: form->from,
 *      there->their) -> a dictionary CANNOT catch these, on principle.
 *      That is a hard limit of the approach and belongs in the product
 *      description rather than being glossed over.
 *
 * Filtering logic comes from ./pipeline.mjs (the same one fp_probe uses).
 *
 * Usage:  node recall_probe.mjs
 */
import nspellPkg from 'nspell';
import dictionary from 'dictionary-en';
import { visibleText, attributeText, checkText } from './pipeline.mjs';

const nspell = nspellPkg.default || nspellPkg;

// ---------------------------------------------------------------- 注入的错字
// kind: 错误类型(用于分析哪类抓不到);where: prose | code | attr
const TYPOS = [
  // —— 常见拼写错误(现实中高频)
  { correct: 'separate',     typo: 'seperate',     kind: '常见拼错' },
  { correct: 'necessary',    typo: 'neccessary',   kind: '双写字母' },
  { correct: 'environment',  typo: 'enviroment',   kind: '漏字母' },
  { correct: 'receive',      typo: 'recieve',      kind: '换位' },
  { correct: 'occurred',     typo: 'occured',      kind: '漏双写' },
  { correct: 'definitely',   typo: 'definately',   kind: '常见拼错' },
  { correct: 'recommend',    typo: 'recomend',     kind: '漏双写' },
  { correct: 'accommodate',  typo: 'accomodate',   kind: '漏双写' },
  { correct: 'successful',   typo: 'succesful',    kind: '漏双写' },
  { correct: 'beginning',    typo: 'begining',     kind: '漏双写' },
  { correct: 'maintenance',  typo: 'maintainance', kind: '常见拼错' },
  { correct: 'privilege',    typo: 'priviledge',   kind: '多字母' },
  { correct: 'consistent',   typo: 'consistant',   kind: '元音错' },
  // —— 打字/邻键错误
  { correct: 'the',          typo: 'teh',          kind: '邻键换位' },
  { correct: 'and',          typo: 'adn',          kind: '邻键换位' },
  { correct: 'with',         typo: 'wiht',         kind: '邻键换位' },
  { correct: 'because',      typo: 'becuase',      kind: '邻键换位' },
  { correct: 'important',    typo: 'improtant',    kind: '邻键换位' },
  // —— ⚠️ 真词错误:结果本身是合法单词,词典原理上抓不到
  { correct: 'form',         typo: 'from',         kind: '真词混淆' },
  { correct: 'then',         typo: 'than',         kind: '真词混淆' },
  { correct: 'there',        typo: 'their',        kind: '真词混淆' },
  { correct: 'lose',         typo: 'loose',        kind: '真词混淆' },
  { correct: 'affect',       typo: 'effect',       kind: '真词混淆' },
  { correct: 'quiet',        typo: 'quite',        kind: '真词混淆' },
];

// 放进 <code> 的错字 —— **预期抓不到,而且这是对的**(代码块不该被拼写检查)
// ⚠️ 必须用**正文里不出现**的独有错字 —— 2026-08-14 第一版用了和正文重复的词,
// 命中来源无法区分,把「正文抓到」误判成「代码块泄漏」。测试自己先要能分辨。
const CODE_TYPOS = ['configuraton', 'mispeled'];

// Misspellings placed in attributes / <title> - text the user never sees
// directly, and a common blind spot for spell checkers.
const ATTR_TYPOS = [
  { attr: 'title-el',   typo: 'Dashbord',   correct: 'Dashboard' },
  { attr: 'alt',        typo: 'Screnshot',  correct: 'Screenshot' },
  { attr: 'placeholder',typo: 'emial',      correct: 'email' },
  { attr: 'aria-label', typo: 'dailog',     correct: 'dialog' },
];

// ---------------------------------------------------------------- 造测试页
function buildPage() {
  const sentences = TYPOS.map((t, i) =>
    `<p>Paragraph ${i + 1}: our team will ${t.typo} the remaining items before the release, ` +
    `so that every reviewer can read the notes without extra effort.</p>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${ATTR_TYPOS[0].typo} overview</title>
</head>
<body>
<nav><a href="/de">Deutsch</a><a href="/pt">Portugu&ecirc;s</a></nav>
<h1>Release notes for the internal ${'dashboard'}</h1>
<img src="/img/a.png" alt="${ATTR_TYPOS[1].typo} of the reporting screen">
<input type="email" placeholder="Enter your ${ATTR_TYPOS[2].typo} address">
<button aria-label="Close the ${ATTR_TYPOS[3].typo}">X</button>
${sentences.join('\n')}
<p>Normal prose with no mistakes at all, so that the precision number means something.
The reporting screen loads quickly and the export finishes without warnings.</p>
<pre><code>const ${CODE_TYPOS[0]} = process.env.NODE_ENV;
// ${CODE_TYPOS[1]} is intentionally misspelled inside code
</code></pre>
<footer>Copyright 2026</footer>
</body></html>`;
}

// ---------------------------------------------------------------- 主流程
function main() {
  const spell = nspell(dictionary);
  const html = buildPage();

  // 自动分类:注入后的词本身是不是合法单词
  for (const t of TYPOS) t.isRealWord = spell.correct(t.typo);

  const vis = checkText(visibleText(html), spell);
  const visSet = new Set(vis.flagged.map(w => w.toLowerCase()));

  let attrChecked = 0;
  const attrSet = new Set();
  for (const { attr, text } of attributeText(html)) {
    const r = checkText(text, spell);
    attrChecked += r.checked;
    for (const w of r.flagged) attrSet.add(w.toLowerCase());
  }

  console.log('=== recall_probe:召回率实测 ===');
  console.log(`测试页:${TYPOS.length} 个正文错字 + ${CODE_TYPOS.length} 个代码块内错字` +
              ` + ${ATTR_TYPOS.length} 个属性/标题错字`);
  console.log(`正文送检 ${vis.checked} 词,报错 ${vis.flagged.length} 个`);
  console.log(`属性送检 ${attrChecked} 词,报错 ${attrSet.size} 个\n`);

  // ---- ① 非词错误(词典应该能抓)
  const nonWord = TYPOS.filter(t => !t.isRealWord);
  const nwHit = nonWord.filter(t => visSet.has(t.typo.toLowerCase()));
  console.log(`--- ① 非词错误(词典能抓的那类)${nwHit.length}/${nonWord.length} ---`);
  for (const t of nonWord) {
    const ok = visSet.has(t.typo.toLowerCase());
    console.log(`  ${ok ? '✅' : '🛑 漏'} ${t.typo.padEnd(14)} (应为 ${t.correct.padEnd(13)}) ${t.kind}`);
  }

  // ---- ② 真词错误(原理上抓不到)
  const realWord = TYPOS.filter(t => t.isRealWord);
  const rwHit = realWord.filter(t => visSet.has(t.typo.toLowerCase()));
  console.log(`\n--- ② 真词错误(词典原理上抓不到)${rwHit.length}/${realWord.length} ---`);
  for (const t of realWord) {
    console.log(`  ${visSet.has(t.typo.toLowerCase()) ? '✅' : '⬜ 抓不到(设计如此)'} ` +
      `${t.typo.padEnd(14)} (本意 ${t.correct.padEnd(13)}) ${t.kind}`);
  }

  // ---- ③ 代码块内(预期 0 命中 = 正确)
  const codeHit = CODE_TYPOS.filter(w => visSet.has(w.toLowerCase()));
  console.log(`\n--- ③ 代码块内错字:命中 ${codeHit.length}/${CODE_TYPOS.length}` +
    `(期望 0 —— 代码块不该被拼写检查)---`);
  console.log(`  ${codeHit.length === 0 ? '✅ 正确跳过' : '🛑 漏进来了:' + codeHit.join(',')}`);

  // ---- 4. Attributes / <title> - the commonly missed class
  const attrHit = ATTR_TYPOS.filter(t => attrSet.has(t.typo.toLowerCase()));
  console.log(`\n--- ④ 属性/标题文本:${attrHit.length}/${ATTR_TYPOS.length} ---`);
  for (const t of ATTR_TYPOS) {
    console.log(`  ${attrSet.has(t.typo.toLowerCase()) ? '✅' : '🛑 漏'} ` +
      `${t.attr.padEnd(12)} ${t.typo.padEnd(12)} (应为 ${t.correct})`);
  }
  console.log('  注:属性文本要单独扫,`visibleText` 剥标签时会把它们一起丢掉。');

  // ---- ⑤ 精确率:报错里有多少不是我注入的
  const injected = new Set([...TYPOS.map(t => t.typo.toLowerCase()),
                            ...CODE_TYPOS.map(w => w.toLowerCase())]);
  const extra = [...visSet].filter(w => !injected.has(w));
  console.log(`\n--- ⑤ 正文误报(报错里非注入的)${extra.length} 个 ---`);
  console.log('  ' + (extra.length ? extra.join(', ') : '(无)'));

  // ---- 判定
  const nwRecall = nonWord.length ? 100 * nwHit.length / nonWord.length : 0;
  console.log('\n--- 判定 ---');
  console.log(`  非词错误召回率 ${nwRecall.toFixed(1)}%  (这是能力上限内的真实指标)`);
  if (nwRecall >= 95) console.log('  ✅ 词典能抓的那类基本全抓到了。');
  else console.log('  🛑 连非词错误都漏,说明跳过规则过于激进,先查是哪条规则误杀。');
  console.log(`  真词错误 ${realWord.length} 个全部抓不到 —— **这是纯词典方案的硬边界**。`);
  console.log('  ⇒ 商店文案不能写"catches all spelling mistakes",');
  console.log('     只能写"catches misspelled words"(并说明不做语法/混淆词)。');
}

main();
