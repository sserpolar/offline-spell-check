/*
 * tokens_check.mjs — 验 collectTokens():产品的分词/偏移是否与实测口径等价
 *
 *
 * 为什么必须单独验这一个函数:
 *   fp_probe / recall_probe 走的是**字符串路径**(visibleText → checkText)。
 *   但扩展里 content script 走的是**DOM 路径**(collectTokens),它多做两件事:
 *     ① 不真的删掉 URL/路径,而是标记成「非散文区间」再跳过落在里面的 token
 *        —— 因为真删字符会让高亮偏移全错
 *     ② 返回每个词在原文里的**偏移量**,好让 document.createRange() 精确定位
 *   这两件事都没有被现有 probe 覆盖。而它们错了的表现是:
 *     · 口径漂移(产品的误报率不再是量到的 0.05%)
 *     - a highlight drawn over the WRONG word (a red underline appearing
 *       under a correctly spelled word)
 *
 * 所以这里验四件事:
 *   ① 单一路径:checkText 从 2026-08-15 起**内部直接调 collectTokens**,
 *      所以两者送检数必须严格相等 —— 这条是防「只给一边加了规则」的哨兵
 *   ①b 两道新闸的预期行为(弯引号 / 非 ASCII 字母碎片),钉死免得被改回去
 *   ② 偏移正确性:对每个返回的 token,text.slice(start,end) 必须严格等于 token.word
 *      —— 这是高亮画对位置的充分必要条件
 *   ③④⑤ 所有格偏移 / 真错字端到端 / 语言门
 *
 * 用法:  node tokens_check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nspellPkg from 'nspell';
import P from './pipeline.mjs';

const NSpell = nspellPkg.default || nspellPkg;
const here = path.dirname(fileURLToPath(import.meta.url));
const DICT = path.join(here, '..', 'src', 'dict');

let failures = 0;
const ok = (m, x = '') => console.log(`  ✅ ${m}${x ? '  ' + x : ''}`);
const bad = (m, x = '') => { failures++; console.log(`  🛑 ${m}${x ? '  ' + x : ''}`); };

// ---------------------------------------------------------------- 测试语料
// 刻意把所有已知坑都塞进来:URL / 路径 / 邮箱 / 带点标识符 / 序数词 / 缩写复数 /
// 连字符前缀 / camelCase / snake_case / 所有格 / 智能引号 / 字母数字混合标识符。
const CASES = [
  ['纯散文 + 真错字',
   'The enviroment was seperate from the maintainance plan. It occured twice.'],
  ['URL 与路径',
   'See https://developer.mozilla.org/en-US/docs/Web/API/fetch and src/main/index.js for detail.'],
  ['邮箱与带点标识符',
   'Mail foo.bar@example.co.uk about window.location.href and config.json today.'],
  ['字母数字标识符(2026-08-14 抓到的分词 bug)',
   "Encodings include 'iso88591', 'iso88593', 'koi8r', 'koi8u' and 'utf16le' here."],
  ['缩写与缩写复数',
   'A set of JavaScript APIs and URLs plus IDs, HTTP and JSON payloads.'],
  ['连字符前缀',
   'pre-existing workspaces use a pre-filled value and non-blocking re-entry.'],
  ['驼峰/下划线/技术术语',
   'The webview getTooltip and my_snake_case helper return a Thenable readonly Uri.'],
  ['所有格与引号',
   `The webview's Uri's owner said 'quoted' and "double" words are boys' toys.`],
  ['序数词与数字',
   'On the 1st, 2nd, 3rd and 123rd day we shipped v1.0.0 and 42 fixes.'],
  ['智能引号(aff 里的 ICONV 会归一化)',
   'It’s the user’s choice, isn’t it?'],
  ['混合大小写句首',
   'Definately not. Recieve the file. TEH quick brown fox.'],
  ['空与边界',
   ''],
  ['只有非散文',
   'https://a.example.com/x/y?z=1 src/a/b.c foo@bar.io'],
];

// ---------------------------------------------------------------- ① 单一分词路径
console.log('\n=== ① checkText 必须与 collectTokens 走同一条分词路径 ===');

const aff = fs.readFileSync(path.join(DICT, 'index.aff'), 'utf8');
const dic = fs.readFileSync(path.join(DICT, 'index.dic'), 'utf8');
const spell = new NSpell(aff, dic);

for (const [label, text] of CASES) {
  const words = P.collectTokens(text).map(t => t.word);
  const ct = P.checkText(text, spell);

  // 2026-08-15 起 checkText 内部直接调 collectTokens,所以送检数**必须严格相等**。
  // 这条是哨兵:防将来有人给其中一条加了规则却忘了另一条。
  if (ct.checked !== words.length) {
    bad(label.padEnd(34), `checkText 送检 ${ct.checked} vs collectTokens ${words.length}`);
    continue;
  }
  // 报错的词必须都出自送检集合(否则说明有词绕过了跳过规则)
  const set = new Set(words);
  const orphan = ct.flagged.filter(w => !set.has(w));
  if (orphan.length) {
    bad(label.padEnd(34), `报错的词不在送检集合里:${orphan.join(', ')}`);
    continue;
  }
  // ⚠️ 报错的词必须**打印出来**,不能只报数量。
  //    2026-08-15 的教训:这条 case 一直显示「报错 1」,我只看了数字没看是哪个词 ——
  //    那个词是 `Encodings`(词典漏收的合法英语词),于是它一路溜到用户的实测里
  //    才被抓出来。**测试只报数量 = 等于没报。**
  ok(label.padEnd(34),
     `送检 ${words.length} 词 · 报错 ${ct.flagged.length}` +
     (ct.flagged.length ? `  → [${ct.flagged.join(', ')}]` : ''));
}

// ---------------------------------------------------------------- ①b 新增两道闸的预期行为
// 2026-08-15 写测试页时抓到的两个真 bug,修完必须钉死预期,否则将来会被改回去。
console.log('\n=== ①b 弯引号 + 非 ASCII 字母碎片(2026-08-15 修的两个 bug) ===');
const EXPECT = [
  ['弯引号缩写/所有格',
   'It isn’t the user’s choice, doesn’t matter, wasn’t either.',
   []],
  ['ASCII 撇号(对照组)',
   "It isn't the user's choice, doesn't matter.",
   []],
  ['重音字母(英文页里的外来词)',
   'We met at the café, read a résumé and a naïve piñata note.',
   []],
  ['语言切换器:被非 ASCII 字母切断的碎片(靠碎片闸)',
   'Español Português Français',
   []],
  // ⚠️ 这一条是**边界文档,不是 bug**。Deutsch / Brasil 是纯 ASCII 拼写的外语词,
  //    分词器完全无从判断 —— 它们看起来就是普通英文单词,只是不在英语词典里。
  //    唯一防线是**逐元素语言门**(element.lang / closest('[lang]')),
  //    真实页面里它们长这样:<li lang="de">Deutsch</li>。
  //    这里喂的是裸字符串、没有任何 lang 标记,所以报错**才是正确行为**。
  //    端到端的验证在 ../test/testpage.html 第 ⑤ 节(带 lang 标记,必须零高亮)。
  ['语言切换器:纯 ASCII 外语词(只能靠逐元素语言门,分词器救不了)',
   'Deutsch Brasil',
   ['Deutsch', 'Brasil']],
  ['技术术语的所有格',
   "The webview's Uri's owner keeps the workspace's config.",
   []],
  ['对照:真错字必须照样报出来',
   'The enviroment is seperate and it occured twice.',
   ['enviroment', 'seperate', 'occured']],
];
for (const [label, text, expected] of EXPECT) {
  const got = P.checkText(text, spell).flagged;
  const same = JSON.stringify(got) === JSON.stringify(expected);
  if (same) {
    ok(label.padEnd(34), expected.length ? `报错 [${got.join(', ')}]` : '零误报');
  } else {
    bad(label.padEnd(34), `期望 [${expected.join(', ')}] 实际 [${got.join(', ')}]`);
  }
}

// ---------------------------------------------------------------- ② 偏移正确性
console.log('\n=== ② 偏移必须精确:text.slice(start,end) === token.word ===');
let offChecked = 0;
let offBad = 0;
for (const [label, text] of CASES) {
  for (const t of P.collectTokens(text)) {
    offChecked++;
    const slice = text.slice(t.start, t.end);
    if (slice !== t.word) {
      offBad++;
      if (offBad <= 10) {
        console.log(`     🛑 ${label}: 期望 "${t.word}" 实际切到 "${slice}" ` +
                    `[${t.start},${t.end})`);
      }
    }
  }
}
offBad === 0
  ? ok('全部偏移精确', `${offChecked} 个 token 逐个切片比对`)
  : bad(`${offBad}/${offChecked} 个偏移错了 —— 高亮会画在错的字上`);

// ---------------------------------------------------------------- ③ 所有格偏移专项
// 归一化会剥掉所有格 's,高亮**只应该画在词干上**,不该把 's 一起标红。
console.log("\n=== ③ 所有格 's 的偏移专项 ===");
{
  const text = "The dashbord's owner and the boys' toys.";
  const toks = P.collectTokens(text);
  const d = toks.find(t => t.word.toLowerCase() === 'dashbord');
  if (!d) {
    bad("没抓到 dashbord(应该被当成候选词送检)");
  } else if (text.slice(d.start, d.end) === 'dashbord') {
    ok("dashbord's → 高亮范围只覆盖 dashbord", `[${d.start},${d.end})`);
  } else {
    bad("所有格偏移错了", `切到 "${text.slice(d.start, d.end)}"`);
  }
  const b = toks.find(t => t.word.toLowerCase() === 'boys');
  if (b && text.slice(b.start, b.end) === 'boys') ok("boys' → 尾引号已剥离");
  else if (b) bad("尾引号偏移错了", `切到 "${text.slice(b.start, b.end)}"`);
}

// ---------------------------------------------------------------- ④ 真错字端到端
// 把 recall_probe 的注入错字用 DOM 路径跑一遍,确认 collectTokens 不会把它们吃掉。
console.log('\n=== ④ 真错字必须能通过 DOM 路径活着到达词典 ===');
{
  const TYPOS = ['seperate', 'neccessary', 'enviroment', 'recieve', 'occured',
    'definately', 'recomend', 'accomodate', 'succesful', 'begining',
    'maintainance', 'priviledge', 'consistant', 'teh', 'adn', 'wiht',
    'becuase', 'improtant'];
  const text = 'Sentence with ' + TYPOS.join(' and ') + ' inside prose.';
  const toks = P.collectTokens(text);
  const got = new Set(toks.map(t => t.word.toLowerCase()));
  const missed = TYPOS.filter(w => !got.has(w));
  const flagged = toks.filter(t => !spell.correct(t.word) && !spell.correct(t.word.toLowerCase()));
  if (!missed.length) ok(`18 个非词错字全部送检`, `实际报错 ${flagged.length} 个`);
  else bad(`有 ${missed.length} 个被跳过规则吃掉了`, missed.join(', '));
  if (flagged.length !== TYPOS.length) {
    bad(`报错数与注入数不符`, `${flagged.length} vs ${TYPOS.length}`);
  }
}

// ---------------------------------------------------------------- ⑤ 语言门
console.log('\n=== ⑤ 语言门(字符串侧) ===');
for (const [lang, expect] of [['en', true], ['en-US', true], ['EN', true],
                              ['de', false], ['zh-CN', false], ['', true]]) {
  const got = P.isEnglish(lang);
  got === expect
    ? ok(`lang="${lang || '(空)'}" → ${got ? '检查' : '跳过'}`)
    : bad(`lang="${lang}" 判定错了`, `期望 ${expect} 实际 ${got}`);
}

// ---------------------------------------------------------------- 判定
console.log('\n=== 判定 ===');
if (failures === 0) {
  console.log('  ✅ DOM 路径与字符串路径等价,偏移精确。高亮会画在对的字上。');
} else {
  console.log(`  🛑 ${failures} 项不通过 —— 先修,别装扩展。`);
  process.exitCode = 1;
}
