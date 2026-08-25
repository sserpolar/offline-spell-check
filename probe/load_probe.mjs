/*
 * load_probe.mjs — 词典首次加载/解析耗时与内存实测
 *
 * 为什么要量:词典 index.dic 有 49,569 行 / 552 KB,nspell 要把它连同词缀规则
 * 全部解析成内存结构。如果这一步明显可感(>300ms),UI 就必须先出「扫描中」状态,
 * 而不是假装即时 —— 这会直接影响骨架的结构(要不要 service worker 预热、
 * 要不要把词典解析放到 offscreen document、popup 打开时要不要显示进度)。
 *
 * ⚠️ 这里量的是 Node 里的耗时。浏览器扩展里读文件走
 * fetch(chrome.runtime.getURL(...)),量级相近但不完全相同;
 * 真扩展搭起来后要在扩展里复量一次。
 *
 * 用法:  node load_probe.mjs [轮数,默认 5]
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nspellPkg from 'nspell';

const nspell = nspellPkg.default || nspellPkg;
const ROUNDS = parseInt(process.argv[2] || '5', 10);

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)),
                      'node_modules', 'dictionary-en');
const affPath = path.join(dir, 'index.aff');
const dicPath = path.join(dir, 'index.dic');

const mb = (b) => (b / 1048576).toFixed(1);
const fmt = (ms) => ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms.toFixed(0) + 'ms';

console.log('=== load_probe:词典加载耗时与内存 ===');
console.log(`index.aff ${fs.statSync(affPath).size} B  |  index.dic ${fs.statSync(dicPath).size} B` +
            `  |  ${fs.readFileSync(dicPath, 'utf8').split('\n').length} 行`);
console.log(`跑 ${ROUNDS} 轮取中位数\n`);

const readTimes = [], buildTimes = [], firstTimes = [], batchTimes = [];
let heapDelta = 0;

const WORDS = ['environment', 'seperate', 'because', 'necessary', 'recieve',
               'the', 'webview', 'occured', 'beginning', 'privilege'];

for (let i = 0; i < ROUNDS; i++) {
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed;

  let t = performance.now();
  const aff = fs.readFileSync(affPath);
  const dic = fs.readFileSync(dicPath);
  readTimes.push(performance.now() - t);

  t = performance.now();
  const spell = nspell({ aff, dic });
  buildTimes.push(performance.now() - t);

  const h1 = process.memoryUsage().heapUsed;
  heapDelta = Math.max(heapDelta, h1 - h0);

  t = performance.now();
  spell.correct('environment');
  firstTimes.push(performance.now() - t);

  t = performance.now();
  for (let k = 0; k < 1000; k++) spell.correct(WORDS[k % WORDS.length]);
  batchTimes.push(performance.now() - t);
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const readMs = med(readTimes), buildMs = med(buildTimes);
const total = readMs + buildMs;

console.log('--- 单轮耗时(中位数)---');
console.log(`  读两个文件        ${fmt(readMs)}`);
console.log(`  nspell 解析构建   ${fmt(buildMs)}   <- 主要成本`);
console.log(`  ---------------------------------`);
console.log(`  首次可用总耗时    ${fmt(total)}`);
console.log(`  构建后首次查询    ${fmt(med(firstTimes))}`);
console.log(`  之后 1000 次查询  ${fmt(med(batchTimes))}  (每次 ${(med(batchTimes) / 1000).toFixed(3)}ms)`);
console.log(`  堆内存增量        约 ${mb(heapDelta)} MB`);

console.log('\n--- 全部轮次(看抖动)---');
console.log('  读:  ' + readTimes.map(x => fmt(x)).join('  '));
console.log('  构建:' + buildTimes.map(x => fmt(x)).join('  '));

console.log('\n--- 对骨架的含义 ---');
if (total < 150) {
  console.log(`  ✅ ${fmt(total)} —— 可以在用户点击后同步初始化,不需要「扫描中」状态。`);
  console.log('     骨架可以最简:content script 里点了就建、就扫。');
} else if (total < 600) {
  console.log(`  ⚠️ ${fmt(total)} —— 可感但不难受。骨架要做两件事:`);
  console.log('     ① 点击后立刻显示「扫描中」,别让界面空着');
  console.log('     ② 词典实例要缓存复用,同一标签页第二次点击不能再付这个钱');
} else {
  console.log(`  🛑 ${fmt(total)} —— 太慢,不能放在点击路径上。骨架必须:`);
  console.log('     ① 在 service worker / offscreen document 里预热词典');
  console.log('     ② 或改用增量/分片解析,先让高频词可用');
}
console.log('\n  ⚠️ 浏览器里读文件走 fetch(chrome.runtime.getURL(...)),量级相近但不等同;');
console.log('     真扩展搭起来后必须在扩展里复量一次(尤其是 service worker 冷启动叠加)。');
