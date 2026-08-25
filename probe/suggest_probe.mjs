/*
 * suggest_probe.mjs — 拼写**建议**质量实测
 *
 * 起因:用户点 demo 页上的 `maintainance`,popup 显示 **no suggestion**。
 *
 * ⭐ 本测试最重要的产出不是一个百分数,而是把失败分成**两类**——因为它们
 *    机理不同、修法不同、严重程度也不同:
 *
 *   ① MISS   一个建议都没给 → 用户看到 `no suggestion`。难看,但至少诚实。
 *   ② WRONG  给了建议,但**正解不在列表里** → 比 ① 更糟:
 *            列表看着很自信,而它是错的。用户会以为「这词就是对的」或者
 *            「这扩展不认识这个词」。
 *
 *   把 ② 单独拎出来是这个脚本的全部价值。只统计「有没有建议」会把
 *   `teh → [ten, eh, meh, tea]` 记成成功 —— 而那正是最丢脸的一条。
 *
 * 补齐逻辑来自 ../shared/suggest.js —— **和产品 import 的是同一个文件**,
 * 所以这里量出来的就是用户点下去会看到的。
 *
 * 用法:  node suggest_probe.mjs
 */
import nspellPkg from 'nspell';
import dictionary from 'dictionary-en';
import { buildSuggestions } from '../shared/suggest.js';

const nspell = nspellPkg.default || nspellPkg;

// ---------------------------------------------------------------- 测试集
// typo → 唯一正解。前 8 个是 test/demo.html 里真埋着的(商店截图会拍到),
// 单独标出来:那 8 个里出一个 MISS/WRONG,截图就废一张。
const DEMO = [
  ['seperate', 'separate'], ['neccessary', 'necessary'], ['recieve', 'receive'],
  ['occured', 'occurred'], ['definately', 'definitely'], ['begining', 'beginning'],
  ['maintainance', 'maintenance'], ['consistant', 'consistent'],
];
const ATTR = [
  ['Dashbord', 'Dashboard'], ['Screnshot', 'Screenshot'], ['mising', 'missing'],
  ['dailog', 'dialog'], ['adress', 'address'],
];
// recall_probe 里那批,含三个**换位**错字 —— 换位是英语打字最常见的错误类型
const OTHER = [
  ['priviledge', 'privilege'], ['accomodate', 'accommodate'], ['succesful', 'successful'],
  ['recomend', 'recommend'], ['improtant', 'important'], ['becuase', 'because'],
  ['enviroment', 'environment'], ['maintainance', 'maintenance'],
  ['teh', 'the'], ['adn', 'and'], ['wiht', 'with'],
];

function run(spell, pairs, label) {
  const rows = [];
  let top1 = 0, inList = 0, miss = 0, wrong = 0, deepUsed = 0, slowest = 0;
  const seenWord = new Set();

  for (const [typo, want] of pairs) {
    if (seenWord.has(typo)) continue;      // maintainance 在两组里都有,只测一次
    seenWord.add(typo);

    const t0 = process.hrtime.bigint();
    const { suggestions, source, deepRan } = buildSuggestions(spell, typo);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > slowest) slowest = ms;
    if (deepRan) deepUsed++;

    const lower = suggestions.map(s => s.toLowerCase());
    const at = lower.indexOf(want.toLowerCase());
    let verdict;
    if (!suggestions.length) { verdict = 'MISS '; miss++; }
    else if (at < 0) { verdict = 'WRONG'; wrong++; }
    else { verdict = at === 0 ? 'TOP1 ' : 'IN' + (at + 1) + '  '; inList++; if (at === 0) top1++; }

    const from = [
      source.swaps.length ? `换位${source.swaps.length}` : '',
      source.base.length ? `nspell${source.base.length}` : '',
      source.deep.length ? `距离2:${source.deep.length}` : '',
    ].filter(Boolean).join('+') || '(全空)';

    rows.push({ typo, want, verdict, suggestions, from, ms });
  }

  const icon = { 'MISS ': '🛑', 'WRONG': '🛑' };
  console.log(`\n=== ${label} (${rows.length} 个) ===`);
  for (const r of rows) {
    console.log(`  ${icon[r.verdict] || '✅'} ${r.verdict} ${r.typo.padEnd(13)}` +
      `→ ${r.want.padEnd(12)} [${r.suggestions.join(', ') || '—'}]`);
    if (r.verdict === 'MISS ' || r.verdict === 'WRONG' || r.ms > 50) {
      console.log(`${' '.repeat(11)}来源 ${r.from} · ${r.ms.toFixed(0)}ms`);
    }
  }
  const n = rows.length;
  console.log(`  ── 正解排第一 ${top1}/${n} · 在列表里 ${inList}/${n}` +
    ` · 🛑MISS ${miss} · 🛑WRONG ${wrong} · 用到距离2兜底 ${deepUsed} 次` +
    ` · 最慢 ${slowest.toFixed(0)}ms`);
  return { miss, wrong, n, inList };
}

function main() {
  const spell = nspell(dictionary);
  console.log('=== suggest_probe:拼写建议质量实测 ===');
  console.log('补齐逻辑 = ../shared/suggest.js(与产品 import 同一份字节)');
  console.log('判定:TOP1=正解排第一 · INn=正解排第 n · 🛑MISS=一个建议都没有' +
              ' · 🛑WRONG=给了建议但正解不在里面(最糟)');

  const a = run(spell, DEMO, '① demo.html 正文里真埋着的 8 个(商店截图会拍到)');
  const b = run(spell, ATTR, '② demo.html 属性/<title> 里的 5 个');
  const c = run(spell, OTHER, '③ recall_probe 那批(含 teh/adn/wiht 三个换位错字)');

  const miss = a.miss + b.miss + c.miss;
  const wrong = a.wrong + b.wrong + c.wrong;
  const n = a.n + b.n + c.n;

  console.log('\n--- 判定 ---');
  console.log(`  合计 ${n} 个 · 正解在列表里 ${a.inList + b.inList + c.inList}` +
              ` · 🛑MISS ${miss} · 🛑WRONG ${wrong}`);
  if (a.miss || a.wrong) {
    console.log('  🛑 **demo.html 那 8 个里有失败** —— 商店截图别拍那个词,先修或换词。');
    process.exitCode = 1;
  } else {
    console.log('  ✅ demo.html 那 8 个全部给出正解 —— 截图点哪个都不会出 `no suggestion`。');
  }
  if (miss || wrong) {
    console.log(`  [!] 全集还有 ${miss + wrong} 个不合格。不阻塞 v1.0.0(文案只承诺` +
                ` "Click a highlight for suggestions",没承诺总能给出正解),`);
    console.log('      但值得进 v1.0.1:根因是**没有词频表**,同距离候选之间排不出优劣。');
  }
}

main();
