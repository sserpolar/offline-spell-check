/*
 * port_check.mjs — 差分验证:ESM 移植版 nspell 必须与原版逐词等价
 *
 *
 * 为什么必须有这一步:
 *   nspell 是 CommonJS,MV3 的 service worker 只吃 ES module,所以手工把上游
 *   9 个文件转成了 ESM(见 ../src/nspell/)。**手工转就有转错的可能**,
 *   而转错的表现是「误报率悄悄变了」或者「某类错字突然抓不到了」——
 *   Neither of these throws - they just silently produce wrong results.
 *
 * 所以不靠「看起来一样」,靠差分:同一份 aff/dic 喂给两个实现,
 *   ① 词表规模必须一致(不只是词数,展开后的派生形式数也要一致)
 *   ② 对**全部展开词条**(约 20 万个)+ 注入错字 + 随机突变词,
 *      correct() 必须逐词返回相同结果 —— 一个都不许差
 *   ③ 对每个注入错字,suggest() 返回的建议列表必须**顺序与内容完全相同**
 *   ④ 顺便验:随包分发的 aff/dic 与 node_modules 里的是否逐字节相同
 *      (防止 copy 的时候被改了行尾或编码)
 *
 * 用法:  node port_check.mjs
 * 期望:  全绿。任何一条红 = 移植有 bug,别往下搭骨架。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import nspellPkg from 'nspell';
import NSpellPort from '../src/nspell/index.js';

const OrigNSpell = nspellPkg.default || nspellPkg;

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT_DICT = path.join(here, '..', 'src', 'dict');
const NM_DICT = path.join(here, 'node_modules', 'dictionary-en');

let failures = 0;
function ok(label, extra = '') {
  console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`);
}
function bad(label, extra = '') {
  failures++;
  console.log(`  🛑 ${label}${extra ? '  ' + extra : ''}`);
}

// ---------------------------------------------------------------- ④ 资产完整性
console.log('\n=== ④ 随包词典资产 vs node_modules(逐字节) ===');
function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
for (const [shipped, upstream] of [
  ['index.aff', 'index.aff'],
  ['index.dic', 'index.dic'],
  ['DICTIONARY-LICENSE.txt', 'license']
]) {
  const a = path.join(EXT_DICT, shipped);
  const b = path.join(NM_DICT, upstream);
  if (!fs.existsSync(a)) { bad(`${shipped} 不存在`); continue; }
  const ha = sha(a), hb = sha(b);
  if (ha === hb) ok(`${shipped.padEnd(24)} 一致`, `sha256 ${ha.slice(0, 12)}…`);
  else bad(`${shipped} 与上游不一致!`, `${ha.slice(0, 12)} vs ${hb.slice(0, 12)}`);
}
// 许可义务自查:词典 license 必须原文照搬进包
const licSize = fs.existsSync(path.join(EXT_DICT, 'DICTIONARY-LICENSE.txt'))
  ? fs.statSync(path.join(EXT_DICT, 'DICTIONARY-LICENSE.txt')).size : 0;
if (licSize > 15000) ok('词典 license 原文在包内', `${licSize.toLocaleString()} 字节`);
else bad('词典 license 缺失或被截断 —— 这是唯一的许可义务,不能漏', `${licSize} 字节`);

// ---------------------------------------------------------------- 构建两个实例
console.log('\n=== ① 构建 + 词表规模 ===');
const aff = fs.readFileSync(path.join(EXT_DICT, 'index.aff'), 'utf8');
const dic = fs.readFileSync(path.join(EXT_DICT, 'index.dic'), 'utf8');

let t = performance.now();
const orig = new OrigNSpell(aff, dic);
const tOrig = performance.now() - t;

t = performance.now();
const port = new NSpellPort(aff, dic);
const tPort = performance.now() - t;

const kOrig = Object.keys(orig.data);
const kPort = Object.keys(port.data);
console.log(`  原版构建 ${tOrig.toFixed(0)}ms   移植版构建 ${tPort.toFixed(0)}ms`);
if (kOrig.length === kPort.length) {
  ok('展开后词表规模一致', `${kOrig.length.toLocaleString()} 个键`);
} else {
  bad('展开后词表规模不一致', `原版 ${kOrig.length} vs 移植版 ${kPort.length}`);
}

// 键集合本身也要一致(规模相同但内容不同也是 bug)
{
  const setPort = new Set(kPort);
  const missing = kOrig.filter(w => !setPort.has(w));
  if (!missing.length) ok('词表键集合完全一致');
  else bad(`移植版缺 ${missing.length} 个键`, missing.slice(0, 8).join(', '));
}

// flags / compoundRules / replacementTable 也比一下
{
  const a = JSON.stringify(Object.keys(orig.flags).sort());
  const b = JSON.stringify(Object.keys(port.flags).sort());
  a === b ? ok('aff flags 键一致') : bad('aff flags 键不一致');
  orig.compoundRules.length === port.compoundRules.length
    ? ok('compoundRules 数量一致', `${orig.compoundRules.length} 条`)
    : bad('compoundRules 数量不一致');
  orig.replacementTable.length === port.replacementTable.length
    ? ok('replacementTable 数量一致', `${orig.replacementTable.length} 条`)
    : bad('replacementTable 数量不一致');
}

// ---------------------------------------------------------------- ② correct() 差分
console.log('\n=== ② correct() 逐词差分 ===');

// 被测词集 = 全部展开词条 + 注入错字 + 随机突变词 + 大小写变体
const TYPOS = ['seperate', 'neccessary', 'enviroment', 'recieve', 'occured',
  'definately', 'recomend', 'accomodate', 'succesful', 'begining',
  'maintainance', 'priviledge', 'consistant', 'teh', 'adn', 'wiht',
  'becuase', 'improtant', 'from', 'than', 'their', 'loose', 'effect', 'quite',
  'configuraton', 'mispeled', 'Dashbord', 'Screnshot', 'emial', 'dailog',
  'programmatically', 'deallocates', 'cancellable', 'deserializing',
  'deduplicate', 'realtime', 'semver', 'stacktrace'];

// 确定性突变(不用随机数,保证可复现):对每第 97 个词做 4 种突变
function mutations(w) {
  if (w.length < 4) return [];
  return [
    w.slice(0, 2) + w.slice(3),                          // 删一个字母
    w.slice(0, 2) + w[2] + w[2] + w.slice(2),            // 双写一个字母
    w.slice(0, 2) + w[3] + w[2] + w.slice(4),            // 换位
    w + 'x'                                              // 尾部加字母
  ];
}

const probe = [];
for (const w of kOrig) probe.push(w);
for (const w of TYPOS) probe.push(w, w.toUpperCase(), w[0].toUpperCase() + w.slice(1));
for (let i = 0; i < kOrig.length; i += 97) probe.push(...mutations(kOrig[i]));
// 大小写变体抽样(form() 里有两级大小写回退,必须覆盖)
for (let i = 0; i < kOrig.length; i += 501) {
  probe.push(kOrig[i].toUpperCase(), kOrig[i].toLowerCase(),
             kOrig[i][0].toUpperCase() + kOrig[i].slice(1));
}
// 所有格 / 引号变体(pipeline 的 normalize 会剥,但这里直接考 nspell)
for (let i = 0; i < kOrig.length; i += 2003) probe.push(kOrig[i] + "'s", "'" + kOrig[i]);

t = performance.now();
let diffs = [];
let trueCount = 0;
for (let i = 0; i < probe.length; i++) {
  const w = probe[i];
  const a = orig.correct(w);
  const b = port.correct(w);
  if (a) trueCount++;
  if (a !== b && diffs.length < 20) diffs.push({ w, orig: a, port: b });
  else if (a !== b) diffs.push({ w, orig: a, port: b });
}
const dt = performance.now() - t;
console.log(`  送检 ${probe.length.toLocaleString()} 个词(其中 ${trueCount.toLocaleString()} 个判为拼对),耗时 ${dt.toFixed(0)}ms`);
if (!diffs.length) ok('correct() 结果 100% 一致 —— 一个都没差');
else {
  bad(`correct() 有 ${diffs.length} 处不一致`);
  for (const d of diffs.slice(0, 20)) {
    console.log(`     "${d.w}"  原版=${d.orig}  移植版=${d.port}`);
  }
}

// ---------------------------------------------------------------- ③ suggest() 差分
console.log('\n=== ③ suggest() 差分(建议顺序与内容都要一致) ===');
let sugDiffs = 0;
let sugTotal = 0;
for (const w of TYPOS) {
  const a = orig.suggest(w);
  const b = port.suggest(w);
  sugTotal++;
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    sugDiffs++;
    console.log(`     🛑 "${w}"`);
    console.log(`        原版   [${a.slice(0, 5).join(', ')}]`);
    console.log(`        移植版 [${b.slice(0, 5).join(', ')}]`);
  }
}
if (!sugDiffs) ok(`suggest() 全部一致`, `${sugTotal} 个错字逐个比对`);
else bad(`suggest() 有 ${sugDiffs}/${sugTotal} 处不一致`);

// 顺便看几个建议长什么样(产品要展示给用户的就是这个)
console.log('\n  抽样看建议质量(产品会把前 5 个展示给用户):');
for (const w of ['seperate', 'occured', 'begining', 'teh', 'enviroment', 'dailog']) {
  console.log(`     ${w.padEnd(14)} → ${port.suggest(w).slice(0, 5).join(', ') || '(无建议)'}`);
}

// ---------------------------------------------------------------- spell() 抽样
console.log('\n=== ⑤ spell() 抽样(forbidden/warn 标记) ===');
{
  let d = 0;
  for (let i = 0; i < kOrig.length; i += 3001) {
    const w = kOrig[i];
    if (JSON.stringify(orig.spell(w)) !== JSON.stringify(port.spell(w))) d++;
  }
  d === 0 ? ok('spell() 抽样一致') : bad(`spell() 抽样有 ${d} 处不一致`);
}

// ---------------------------------------------------------------- 判定
console.log('\n=== 判定 ===');
if (failures === 0) {
  console.log('  ✅ 移植版与原版 nspell 行为等价。可以进扩展了。');
  console.log(`  构建耗时 移植版 ${tPort.toFixed(0)}ms vs 原版 ${tOrig.toFixed(0)}ms ` +
              `(BENCHMARK.md records 61ms,同一量级即可)`);
} else {
  console.log(`  🛑 ${failures} 项不通过 —— **移植有 bug,先修它,别搭骨架**。`);
  process.exitCode = 1;
}
