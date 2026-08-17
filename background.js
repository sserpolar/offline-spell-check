/*
 * background.js — MV3 service worker:词典的**唯一**持有者
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么词典必须在这里,不在 content script 里
 * ════════════════════════════════════════════════════════════════════
 * 实测(spell-probe/load_probe.mjs):一个词典实例占**堆内存 20.7 MB**
 * (展开后 123,702 个词形)。如果在 content script 里建,那就是**每个标签页一份** ——
 * 用户开 20 个标签页各点一次 = 400 MB。这不可接受,而且是那种「用一周才发现
 * 浏览器变慢」的问题,上线后只会变成看不懂原因的差评。
 *
 * 所以:词典在 service worker 里**只有一份**。content script 一个字典都不建,
 * 它只做 DOM 遍历 + 收词 + 画高亮,把候选词**批量**丢过来查。
 *
 * ⚠️ MV3 的 service worker 会被 Chrome 回收(通常空闲 30s 左右)。
 *    所以这里**不假设常驻** —— 词典按需重建。重建成本实测:
 *      · 61ms   = load_probe 7 轮取中位数(JIT 已热)
 *      · ~100ms = 单次冷跑实测(port_check.mjs:移植版 101ms / 原版 126ms)
 *    service worker 每次冷启动都是**冷跑**,所以按 100ms 量级预期,不是 61ms。
 *    100ms 仍然可以直接放在用户点击路径上,**不需要「扫描中」状态**。
 *
 * ⚠️ 批量,不要逐词发。单次 correct() 实测 < 0.001ms(1000 次 < 1ms),
 *    成本几乎全在消息序列化。逐词发 5000 个词 = 5000 次往返,能慢两个数量级。
 * ════════════════════════════════════════════════════════════════════
 */

import NSpell from './src/nspell/index.js';

// ---------------------------------------------------------------- 词典生命周期

const AFF_PATH = 'src/dict/index.aff';
const DIC_PATH = 'src/dict/index.dic';

/** service worker 这次被拉起来的时刻 —— 用来在 popup 里显示「这次是不是冷启动」 */
const SW_BOOT_AT = Date.now();

/** @type {Promise<{spell: any, timing: object}>|null} 只建一次;SW 被回收后自动清零 */
let dictPromise = null;

/** 上一次构建的耗时明细。CHECK 的响应里会带上它;单独留一份便于在
 *  service worker 控制台里直接查看(`lastTiming`)。 */
let lastTiming = null;

async function buildDictionary() {
  const t0 = performance.now();

  // ⚠️ dictionary-en 的 index.js 用 node:fs 读文件,浏览器里根本不能用。
  //    所以 index.aff / index.dic 是当**静态资源**打包的,用 getURL + fetch 读。
  //    这两个文件在包内,fetch 自己的扩展资源不需要任何权限,
  //    也**不需要** web_accessible_resources(那个字段是给网页读扩展资源用的,
  //    我们不给网页读任何东西 —— build.py 里它也是被硬拦的字段)。
  const [aff, dic] = await Promise.all([
    fetch(chrome.runtime.getURL(AFF_PATH)).then(r => r.text()),
    fetch(chrome.runtime.getURL(DIC_PATH)).then(r => r.text())
  ]);
  const tFetched = performance.now();

  const spell = new NSpell(aff, dic);
  const tBuilt = performance.now();

  const timing = {
    fetchMs: Math.round(tFetched - t0),
    parseMs: Math.round(tBuilt - tFetched),
    totalMs: Math.round(tBuilt - t0),
    affBytes: aff.length,
    dicBytes: dic.length,
    builtAtMsSinceSwBoot: Date.now() - SW_BOOT_AT
  };
  lastTiming = timing;

  console.log(
    `[spell] dictionary ready: fetch ${timing.fetchMs}ms + parse ${timing.parseMs}ms ` +
    `= ${timing.totalMs}ms (SW booted ${timing.builtAtMsSinceSwBoot}ms ago)`
  );

  return { spell, timing };
}

function getDictionary() {
  if (!dictPromise) {
    // 失败要能重试:出错就把 promise 清掉,否则一次网络抽风就永久坏掉。
    dictPromise = buildDictionary().catch(err => {
      dictPromise = null;
      throw err;
    });
  }
  return dictPromise;
}

// ---------------------------------------------------------------- 消息处理

/**
 * 批量查词。
 * @param {string[]} words 已去重的候选词(去重在 content script 做,那边有原文)
 * @returns {Promise<{misspelled:string[], timing:object}>}
 */
async function checkWords(words) {
  const wasCold = dictPromise === null;
  const { spell, timing } = await getDictionary();

  const t0 = performance.now();
  const misspelled = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (spell.correct(w)) continue;
    // 句首大写回退。nspell 的 form() 内部已经做了大小写回退,这一行几乎总是多余,
    // 但成本是 0.000ms 级,留着当保险(与 pipeline.checkText 的行为保持一致)。
    if (spell.correct(w.toLowerCase())) continue;
    misspelled.push(w);
  }
  const lookupMs = performance.now() - t0;

  return {
    misspelled,
    timing: {
      ...timing,
      // 这次请求是否触发了词典构建(即:是否吃到了冷启动全价)
      dictionaryWasCold: wasCold,
      lookupMs: Math.round(lookupMs * 1000) / 1000,
      wordsChecked: words.length,
      swBootAt: SW_BOOT_AT,
      msSinceSwBoot: Date.now() - SW_BOOT_AT
    }
  };
}

/**
 * 拼写建议 —— **只按需调用**。
 * suggest() 比 correct() 贵得多(要生成编辑距离 1~2 的全部候选再逐个查表),
 * 所以绝不在扫描时给所有错词预先算建议:用户点了哪个词才算哪个。
 */
async function suggestFor(word) {
  const { spell } = await getDictionary();
  const t0 = performance.now();
  const suggestions = spell.suggest(word).slice(0, 6);
  return { suggestions, ms: Math.round(performance.now() - t0) };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  // ⚠️ MV3:异步响应必须 `return true`,否则消息通道会在 respond 之前就关掉。
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'CHECK': {
          const words = Array.isArray(msg.words) ? msg.words : [];
          respond({ ok: true, ...(await checkWords(words)) });
          break;
        }
        case 'SUGGEST': {
          respond({ ok: true, word: msg.word, ...(await suggestFor(String(msg.word || ''))) });
          break;
        }
        case 'WARMUP': {
          // 可选预热:popup 一打开就开始建词典,用户读完那两行字的时间里就建完了。
          // 不阻塞:立刻回,构建在后台跑。
          getDictionary().catch(() => {});
          respond({ ok: true });
          break;
        }
        default:
          respond({ ok: false, error: 'unknown message type: ' + (msg && msg.type) });
      }
    } catch (err) {
      console.error('[spell] handler failed', err);
      respond({ ok: false, error: String(err && err.message || err) });
    }
  })();

  return true;
});

// 安装/更新时留一行日志,方便在 chrome://extensions 的 service worker 控制台里确认版本。
chrome.runtime.onInstalled.addListener(details => {
  console.log(`[spell] ${chrome.runtime.getManifest().version} installed (${details.reason})`);
});
