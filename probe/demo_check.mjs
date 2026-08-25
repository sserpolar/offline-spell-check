/*
 * demo_check.mjs — 商店截图用的 demo 页出图前自检
 *
 * 为什么要有这一道:`test/demo.html` 是**给陌生人看的**素材,不是给开发者看的
 * 测试页,所以它上面不许有一条 `Expected:` 注解 —— 于是「这页到底会不会
 * 多标一个词」就没有任何肉眼线索了。而截图里多出一条红波浪线,
 * 在商店页面上等于当众展示一次误报。
 *
 * ⭐ 本测试的产出不是一个百分数,而是**四张点名清单**:
 *   ① 正文该抓到的 8 个错字 —— 一个不许漏
 *   ② 属性/<title> 该抓到的 5 个 —— 一个不许漏
 *   ③ 代码块里的 2 个 —— 一个都不许冒出来(代码不该被拼写检查)
 *   ④ **多余的报错必须是 0** —— 这条是本脚本存在的唯一理由。
 *      我自己写的散文里只要有一个词词典不认(比如 dashboard / docs / dataset
 *      这类现代技术词),截图上就会白多一条红线。
 *
 * 过滤逻辑来自 ./pipeline.mjs,也就是产品跑的那同一份字节。
 *
 * ⚠️ 两处「probe 侧补齐」——字符串版 pipeline 没有 DOM,下面这两条是拿正则
 *    模仿产品里的 `el.closest(...)`,不是另一套规则:
 *    · 逐元素语言门:产品用 isEnglishElement(el);这里把带非英语 lang 的元素
 *      连内容一起剪掉(demo 页里就是那个 lang="de" 的 aside 和 5 个语言链接)。
 *    · 属性的跳过标签门:产品在 walkAttributes 里过 el.closest(SKIP_SELECTOR);
 *      这里在扫属性前先剪掉 nav/footer/code/pre… 这些块(留下 title/head)。
 *    剪掉了什么下面会**打印出来**,不是默默做掉。
 *
 * 用法:  node demo_check.mjs
 */
import nspellPkg from 'nspell';
import dictionary from 'dictionary-en';
import { visibleText, attributeText, checkText, pageLang, isEnglish, SKIP_TAGS }
  from './pipeline.mjs';
import { readFileSync } from 'node:fs';

const nspell = nspellPkg.default || nspellPkg;
const PAGE = new URL('../test/demo.html', import.meta.url);

// ---------------------------------------------------------------- 期望清单
// 这里写的是「demo.html 里我故意埋了什么」。改页面就要同步改这里,
// 两边不一致时下面会点名报出来。
const PROSE = [
  { typo: 'seperate',     correct: 'separate',    where: 'Highlights 第 1 段' },
  { typo: 'neccessary',   correct: 'necessary',   where: 'Highlights 第 2 段' },
  { typo: 'recieve',      correct: 'receive',     where: 'Highlights 第 3 段' },
  { typo: 'occured',      correct: 'occurred',    where: 'Fixes 第 1 条' },
  { typo: 'definately',   correct: 'definitely',  where: 'Fixes 第 2 条' },
  { typo: 'begining',     correct: 'beginning',   where: 'Fixes 第 3 条' },
  { typo: 'maintainance', correct: 'maintenance', where: 'Upgrade notes 第 1 段' },
  { typo: 'consistant',   correct: 'consistent',  where: 'Upgrade notes 第 2 段' },
];

const ATTR = [
  { typo: 'Dashbord',  correct: 'Dashboard',  attr: 'title-el',   where: '<title>(只在浏览器标签栏)' },
  { typo: 'Screnshot', correct: 'Screenshot', attr: 'alt',        where: 'figure 里的图' },
  { typo: 'mising',    correct: 'missing',    attr: 'placeholder',where: '反馈卡的输入框' },
  { typo: 'dailog',    correct: 'dialog',     attr: 'aria-label', where: '反馈卡的 × 按钮' },
  { typo: 'adress',    correct: 'address',    attr: 'title',      where: '反馈卡的 Anonymous 提示' },
];

// 代码块里的错字 —— **期望一个都抓不到**,而且这是对的。
// ⚠️ 必须是正文里不出现的独有拼法,否则命中来源分不清
//    (recall_probe 2026-08-14 踩过这个坑:把「正文抓到」误判成「代码块泄漏」)。
const CODE = ['occurance', 'retreive'];

// 德语块的标志词 —— 期望一个都不许出现在报错里。
const GERMAN = ['Berichte', 'Arbeitsbereich', 'Einstellungen', 'Deutsch', 'Espa', 'Portugu'];

// ---------------------------------------------------------------- probe 侧补齐 ①
/** 找 tagName 的配对闭合标签,返回它的右边界(带深度计数,能吃嵌套)。 */
function matchingCloseEnd(html, tagName, fromIdx) {
  const re = new RegExp('<(/?)' + tagName + '\\b[^>]*>', 'gi');
  re.lastIndex = fromIdx;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === '/') { if (--depth === 0) return re.lastIndex; }
    else depth++;
  }
  return -1;
}

/**
 * 模仿产品的逐元素语言门:把带非英语 lang 的元素连内容一起剪掉。
 * 产品里这一步是 isEnglishElement(el) → el.closest('[lang]')。
 */
function stripNonEnglishBlocks(html) {
  const removed = [];
  const openRe = /<([a-zA-Z][\w-]*)\b[^>]*\blang\s*=\s*["']([a-zA-Z-]{2,7})["'][^>]*>/i;
  for (let guard = 0; guard < 200; guard++) {
    const m = openRe.exec(html);
    if (!m) break;
    const [full, tag, lang] = m;
    if (isEnglish(lang)) {
      // 英语的不剪。为了让下一轮能往后找,先把这个 lang= 改名字躲开正则。
      html = html.slice(0, m.index) + full.replace(/\blang\s*=/i, 'data-langok=') +
             html.slice(m.index + full.length);
      continue;
    }
    const end = matchingCloseEnd(html, tag, m.index + full.length);
    if (end < 0) throw new Error(`<${tag} lang="${lang}"> 找不到配对闭合标签`);
    const inner = html.slice(m.index + full.length, end).replace(/<[^>]+>/g, ' ')
                      .replace(/\s+/g, ' ').trim();
    removed.push({ tag, lang, sample: inner.slice(0, 46) + (inner.length > 46 ? '…' : '') });
    html = html.slice(0, m.index) + ' ' + html.slice(end);
  }
  return { html, removed };
}

// ---------------------------------------------------------------- probe 侧补齐 ②
/** 扫属性前先剪掉跳过标签的块(留 title/head)。产品里是 el.closest(SKIP_SELECTOR)。 */
function stripSkipBlocksForAttrs(html) {
  const cut = [];
  for (const t of SKIP_TAGS) {
    if (t === 'title' || t === 'head') continue;
    const re = new RegExp('<' + t + '\\b[^>]*>[\\s\\S]*?<\\/' + t + '>', 'gi');
    const n = (html.match(re) || []).length;
    if (n) cut.push(`${t}×${n}`);
    html = html.replace(re, ' ');
  }
  return { html, cut };
}

// ---------------------------------------------------------------- 主流程
function main() {
  const spell = nspell(dictionary);
  const raw = readFileSync(PAGE, 'utf8');

  console.log('=== demo_check:商店截图页自检 ===');
  console.log(`页面:${PAGE.pathname.replace(/^\//, '')}  (${raw.length} 字节)`);
  console.log(`<html lang> = "${pageLang(raw)}" → ${isEnglish(pageLang(raw)) ? '按英语检查' : '⚠️ 整页会被语言门跳过!'}\n`);

  // ---- ⓪ 先把该由 DOM 门拦掉的剪掉,并打印剪了什么
  const { html: langClean, removed } = stripNonEnglishBlocks(raw);
  console.log(`--- ⓪ 语言门(probe 侧模仿 isEnglishElement)剪掉 ${removed.length} 个块 ---`);
  for (const r of removed) console.log(`  <${r.tag} lang="${r.lang}">  「${r.sample}」`);

  // ---- 正文
  const vis = checkText(visibleText(langClean), spell);
  const visSet = new Set(vis.flagged.map(w => w.toLowerCase()));

  // ---- 属性 / <title>
  const { html: attrHtml, cut } = stripSkipBlocksForAttrs(langClean);
  const attrHits = new Map();   // 小写词 → 它出自哪个属性
  let attrChecked = 0;
  for (const { attr, text } of attributeText(attrHtml)) {
    const r = checkText(text, spell);
    attrChecked += r.checked;
    for (const w of r.flagged) if (!attrHits.has(w.toLowerCase())) attrHits.set(w.toLowerCase(), attr);
  }
  console.log(`\n--- 属性扫描前剪掉的跳过标签块:${cut.join(' · ') || '(无)'} ---`);
  console.log(`正文送检 ${vis.checked} 词,报错 ${vis.flagged.length} 个`);
  console.log(`属性送检 ${attrChecked} 词,报错 ${attrHits.size} 个`);

  let bad = 0;

  // ---- ① 正文该抓到的
  const proseMiss = PROSE.filter(t => !visSet.has(t.typo.toLowerCase()));
  console.log(`\n--- ① 正文错字 ${PROSE.length - proseMiss.length}/${PROSE.length} ---`);
  for (const t of PROSE) {
    const ok = visSet.has(t.typo.toLowerCase());
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '🛑 漏'} ${t.typo.padEnd(13)} (应为 ${t.correct.padEnd(12)}) ${t.where}`);
  }

  // ---- ② 属性该抓到的
  const attrMiss = ATTR.filter(t => !attrHits.has(t.typo.toLowerCase()));
  console.log(`\n--- ② 属性 / <title> 错字 ${ATTR.length - attrMiss.length}/${ATTR.length} ---`);
  for (const t of ATTR) {
    const got = attrHits.get(t.typo.toLowerCase());
    if (!got) bad++;
    console.log(`  ${got ? '✅' : '🛑 漏'} ${t.attr.padEnd(11)} ${t.typo.padEnd(11)}` +
                ` (应为 ${t.correct.padEnd(11)}) ${t.where}${got && got !== t.attr ? `  ⚠️ 实际来自 ${got}` : ''}`);
  }

  // ---- ③ 代码块必须一个都不冒出来
  const codeLeak = CODE.filter(w => visSet.has(w.toLowerCase()) || attrHits.has(w.toLowerCase()));
  console.log(`\n--- ③ 代码块内错字泄漏 ${codeLeak.length}/${CODE.length}(期望 0)---`);
  if (codeLeak.length) { bad++; console.log('  🛑 冒出来了:' + codeLeak.join(', ')); }
  else console.log(`  ✅ ${CODE.join(' / ')} 都被 <pre><code> 挡住了`);

  // ---- ④ 德语块必须一个都不冒出来
  const deLeak = GERMAN.filter(w => visSet.has(w.toLowerCase()));
  console.log(`\n--- ④ 德语块/语言链接泄漏 ${deLeak.length}(期望 0)---`);
  if (deLeak.length) { bad++; console.log('  🛑 冒出来了:' + deLeak.join(', ')); }
  else console.log('  ✅ lang="de" 的整块和 5 个语言链接都没有一个词被送检');

  // ---- ⑤ ⭐ 多余报错 —— 本脚本的核心
  const planned = new Set([...PROSE, ...ATTR].map(t => t.typo.toLowerCase()));
  const extraVis = [...visSet].filter(w => !planned.has(w));
  const extraAttr = [...attrHits.keys()].filter(w => !planned.has(w));
  console.log(`\n--- ⑤ ⭐ 计划外报错(截图上会白多一条红线)正文 ${extraVis.length} · 属性 ${extraAttr.length} ---`);
  if (extraVis.length || extraAttr.length) {
    bad++;
    for (const w of extraVis) console.log(`  🛑 正文 "${w}" —— 改掉这个词,或确认它真是术语后加进 pipeline.js 的 TECH 表`);
    for (const w of extraAttr) console.log(`  🛑 属性 "${w}"(来自 ${attrHits.get(w)})`);
  } else {
    console.log('  ✅ 一个都没有 —— 页面上出现的每一条红线/琥珀框都是我故意埋的');
  }

  // ---- 跳过统计(看规则有没有在干活)
  const stats = Object.entries(vis.skipStats).sort((a, b) => b[1] - a[1]);
  console.log(`\n--- 正文跳过统计(共 ${vis.total} 个 token)---`);
  console.log('  ' + (stats.map(([k, v]) => `${k}=${v}`).join(' · ') || '(无)'));

  // ---- 判定
  console.log('\n--- 判定 ---');
  if (bad === 0) {
    console.log(`  ✅ 可以出图。截图里应当正好是 ${PROSE.length} 条红波浪线` +
                ` + 4 个琥珀虚线框(<title> 那条只进 popup 列表,页面上没有位置)。`);
    console.log(`  popup 三个数字预期:misspelled ${PROSE.length} · in attributes ${ATTR.length}` +
                ` · words checked ≈ ${vis.checked}(DOM 提取与字符串提取会差几个词,量级对上就行)`);
  } else {
    console.log(`  🛑 ${bad} 项不合格 —— 先按上面的点名修 demo.html,别急着截图。`);
    process.exitCode = 1;
  }
}

main();
