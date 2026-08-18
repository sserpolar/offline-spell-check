/*
 * suggest.js — 拼写**建议**的补齐逻辑【单一真源】
 *
 * 副业军师 2026-08-17。
 *
 * ⭐⭐ 这个文件是**唯一一份**建议补齐逻辑,产品和 probe 都 import 它。
 *     · 产品:`background.js`(service worker 是 `type: module`,直接 ESM import)
 *     · 实测:`spell-probe/suggest_probe.mjs`
 *     ⇒ **产品跑的字节和 suggest_probe 量出来的字节是同一份。**
 *
 * ⚠️ 和 `shared/pipeline.js` 分工不同,别混:
 *     pipeline.js = **过滤 / 检测**(哪些词送检、哪些跳过)。误报 0.05% 和
 *                   非词召回 18/18 这两个数字由它决定。
 *     本文件     = **建议**(已经判定错了之后,给什么替换词)。
 *     ⇒ 改本文件对检测行为**零影响**,那两个数字在原理上就动不了。
 *       (话虽如此,改完还是重跑了 recall_probe + fp_probe 复核 ——
 *        「原理上不会」和「实测没变」是两件事。)
 *
 * ⚠️ 为什么不用 pipeline.js 那套 IIFE 双消费格式:那是因为 content script 由
 *    `executeScript` 当 **classic script** 注入,吃不了 ES module。而建议逻辑
 *    只在 service worker(module)和 Node 里跑,两边都吃 ESM,所以不需要那个 hack。
 *
 * ------------------------------------------------------------------ 为什么要有这一层
 * 起因:2026-08-17 用户点 demo 页上的 `maintainance`,popup 显示 **no suggestion**。
 * 顺着量了 23 个已知错字(见 suggest_probe.mjs),发现是**两个机理不同**的毛病:
 *
 *   ① nspell **不生成相邻字符换位**候选 —— 而换位是英语打字最常见的错误:
 *        teh  → [ten, eh, meh, tea]      ← **没有 the**
 *        adn  → [adj, adv, ad, add]      ← **没有 and**
 *        wiht → [whit, wight, wilt, …]   ← **没有 with**
 *      ⚠️ 这比「没有建议」更糟:列表看着很自信,正解却根本不在里面。
 *      修法 = n-1 个换位候选拿 correct() 验一遍。实测精度极高,
 *      因为垃圾候选(teh 的 `eth`、adn 的 `dan`)自己就被词典挡掉了:
 *        teh→[the] · adn→[and] · wiht→[whit, with]
 *
 *   ② **编辑距离 2 完全够不着**:`maintainance → maintenance` 需要
 *      「删掉 i」+「a→e」两步,nspell 直接返回空数组。
 *      修法 = 对每个「删一个字符」的结果再跑一次 suggest()。
 *      实测 `maintainance` 由此得到**恰好一个**候选 `maintenance`。
 *
 * ⚠️⚠️ ② 只在 nspell **一个都没给**的时候才跑。两个理由都是实测的,别放宽:
 *      · **短词上它喷垃圾**:`teh` 这么搞会冒出 **75 个**(eh, oh, tb, tn, uh, Th…)
 *      · **贵**:`maintainance` 要 **369ms**(12 个删法 × 每次约 30ms);
 *        `seperate` 要 159ms
 *      ⇒ 本来就有正解的常见情形不该付这个钱。「本来什么都没有」的时候,
 *        369ms 换一个正解是划算的 —— 而且 popup 点击时已经显示 `looking up…`,
 *        这个延迟有地方落。
 *
 * ⚠️ 已知不足,留给 v1.0.1:**没有词频表**,所以同为距离 1 的候选之间排序是任意的。
 *    `wiht` 给的是 `[whit, with]` —— 正解在列表里,但不在第一位。
 *    要排对得随包带一份小词频表(几十 KB),那是另一件事。
 */

export const SUGGEST_MAX = 6;

/** 相邻字符换位的全部候选(n-1 个)。 */
export function transposeCandidates(word) {
  const out = [];
  for (let i = 0; i < word.length - 1; i++) {
    out.push(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
  }
  return out;
}

/** 删掉一个字符的全部候选(n 个)。 */
export function deleteCandidates(word) {
  const out = [];
  for (let i = 0; i < word.length; i++) out.push(word.slice(0, i) + word.slice(i + 1));
  return out;
}

/**
 * 编辑距离是否 <= max。按行算,行最小值一超标就退出,不算满矩阵。
 * 只用来卡掉八竿子打不着的候选,不需要精确距离值。
 */
export function withinDistance(a, b, max) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;   // 这一行整体已超标,再往下只会更大
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * 给一个已判定拼错的词算建议。
 *
 * @param {{correct:(w:string)=>boolean, suggest:(w:string)=>string[]}} spell
 *        nspell 实例(注入进来,好让 probe 用自己那个)
 * @param {string} word
 * @param {number} [max]
 * @returns {{suggestions:string[], source:{swaps:string[], base:string[], deep:string[]},
 *            deepRan:boolean}}
 *          source 分三路返回是**故意**的:出问题时要能一眼看出「这条建议是哪来的」。
 *          测试只报数量不报来源,是这个项目吃过亏的地方。
 */
export function buildSuggestions(spell, word, max = SUGGEST_MAX) {
  const ok = w => spell.correct(w) || spell.correct(w.toLowerCase());

  const base = spell.suggest(word);

  // ---- ① 换位补齐:总是做(便宜),排在最前面
  const swaps = [];
  for (const c of transposeCandidates(word)) {
    if (c !== word && ok(c) && !swaps.includes(c)) swaps.push(c);
  }

  // ---- ② 距离 2 兜底:**只在前两路都空**的时候才做
  const deep = [];
  const deepRan = !base.length && !swaps.length;
  if (deepRan) {
    const seen = new Set();
    for (const d of deleteCandidates(word)) {
      for (const s of spell.suggest(d)) {
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        // 由构造只保证 <=3,这里显式卡回 <=2
        if (withinDistance(word, s, 2)) deep.push(s);
      }
    }
  }

  const seen = new Set();
  const suggestions = [];
  for (const w of [...swaps, ...base, ...deep]) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    suggestions.push(w);
    if (suggestions.length === max) break;
  }
  return { suggestions, source: { swaps, base, deep }, deepRan };
}
