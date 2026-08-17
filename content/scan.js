/*
 * content/scan.js — 页面侧:遍历 DOM、收词、画高亮
 *
 * ════════════════════════════════════════════════════════════════════
 * 这个文件里**没有词典**,一个都没有。
 * ════════════════════════════════════════════════════════════════════
 * 词典占 20.7 MB,只在 service worker 里存唯一一份(见 background.js 顶部注释)。
 * 这里只做四件事:
 *   ① 遍历 DOM 找可见英文散文(照 shared/pipeline.js 的规则)
 *   ② 收唯一候选词,**一条消息批量**丢给 service worker 查
 *   ③ 拿回错词列表后**再走一趟** DOM,只为真错词建 Range 画高亮
 *   ④ 用户点了某个高亮,才现问 service worker 要建议
 *
 * 为什么要走两趟 DOM?
 *   一趟走完就存下全部候选词的偏移量 = 6.5 万个 {node,start,end} 对象常驻内存。
 *   两趟的代价只是再遍历一次(遍历本身很快,实测查词 1000 次 < 1ms,成本全在遍历),
 *   换来的是**内存只为真正的错词买单**(通常几十个)。
 *
 * 高亮方案:文档坐标 + closed shadow root,**不碰页面 DOM 一个字节**
 *   · 不用 <span> 包裹文字 —— 那会改页面结构,可能撞坏页面自己的脚本与样式
 *   · 不用 contenteditable 借 Chrome 内置检查器 —— 在位者那类做法会**悄悄弄死
 *     页面上所有链接**,这是商店文案里明写的差异点
 *   · 标记层用 position:absolute + **文档坐标** → 滚动时浏览器自己带着走,
 *     不需要监听 scroll 重算,零成本
 *   · closed shadow root → 页面的 CSS 和脚本都碰不到我们的样式
 *
 * 已知边界(README 里也写了,不藏):
 *   · position:fixed 元素里的高亮,页面滚动后会错位 → 重新点一次扫描即可。
 *     (故意不修:修它要在每帧页面滚动时重算 rect,把「滚动零成本」这个
 *      最大的好处赔掉。而 fixed 元素通常是导航/页头,`nav` 本来就在跳过表里。)
 *   · 只扫主框架,不进 iframe。
 *   · 内部滚动容器(overflow:auto)**已修**,分两步,两步都必需:
 *       ① document 上的捕获阶段 scroll 监听 → 容器滚动时重算位置
 *       ② 标记矩形与**裁剪祖先求交** → 文字滚出框时标记跟着被裁掉
 *     只做 ① 的话标记会正确地跟着文字**飘到框外面**(标记层挂在
 *     documentElement 上,不受任何容器的 overflow 裁剪)。2026-08-15 用户
 *     两轮实测才逼出来的。
 */

(function () {
  'use strict';

  const VERSION = (() => {
    try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; }
  })();

  // ── 注入即接管 ─────────────────────────────────────────────────
  // popup 每次点图标都会重新 executeScript 一遍这个文件。
  //
  // ⚠️ 这里**不能**用「已经注入过就 return」的布尔守卫,那会留下一个真 bug:
  //    扩展重新加载(开发时)或自动更新(上线后)之后,页面里这一份旧脚本的
  //    chrome.runtime 已经失效 —— 它的消息监听再也收不到任何东西。
  //    而布尔守卫会让新注入的脚本直接 return,于是这个标签页里点图标
  //    **永远没反应**,直到用户手动刷新页面。
  //    开发时表现为「改完代码重装扩展,点了没用」;
  //    上线后表现为「扩展自动更新那天,所有开着的标签页都失灵」。
  //
  //    也不能靠比版本号:开发时重装,版本号是不变的(都还是 1.0.0),照样漏。
  //
  //    ⇒ 规则简单粗暴但在所有情况下都对:**每次注入都把上一份拆干净,由本次接管。**
  //    代价只是几个 removeEventListener,可以忽略;而且 scan() 本来第一步就是 clear()。
  // (content script 跑在 isolated world,这个全局变量页面看不见也改不了。)
  const prev = globalThis.__OFFLINE_SPELL_CHECK__;
  if (prev && typeof prev.destroy === 'function') {
    try { prev.destroy(); } catch (_) {}
  }

  const P = globalThis.SpellPipeline;
  if (!P) {
    console.error('[spell] shared/pipeline.js 没先注入 —— executeScript 的 files 顺序错了');
    return;
  }

  const HOST_ID = '__offline_spell_check_layer__';

  /** 当前这轮扫描的结果。结构见 buildFindings()。 */
  let findings = [];
  /** shadow root 与标记层 */
  let shadow = null;
  let layer = null;
  let popover = null;
  /** 标记层原点(文档坐标)—— 由 host 自己的 rect 反推,见 ensureLayer() */
  let originX = 0;
  let originY = 0;

  // ================================================================ 元素闸门

  /**
   * 每个元素只判一次,结果缓存。深层 DOM 里 closest() 是主要开销,
   * 而同一个元素常常挂着多个文本节点。
   * @type {WeakMap<Element, boolean>}
   */
  let gateCache = new WeakMap();

  function isVisible(el) {
    // checkVisibility 是 Chrome 105+ 的,一次调用把 display:none / visibility:hidden /
    // content-visibility 全判完。老版本退回手工判断。
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
    }
    if (el.offsetParent !== null) return true;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  /** 这个元素里的文本要不要检查? */
  function elementPasses(el) {
    const cached = gateCache.get(el);
    if (cached !== undefined) return cached;

    let pass = true;
    // ① 跳过标签:代码块 / 导航 / 语言切换器 / <title>(由属性扫描单独处理)
    if (el.closest(P.SKIP_SELECTOR)) pass = false;
    // ② ⭐ 逐元素语言门。实测:没有语言门时,一个被服务成德语的页面误报率 75.48%。
    //    必须逐元素做 —— 多语言站的语言切换器就在页内(<li lang="de">Deutsch</li>),
    //    只看整页 <html lang> 拦不住它。
    else if (!P.isEnglishElement(el)) pass = false;
    // ③ 看不见的东西不报错(用户没法「看到」一个 display:none 里的错字)
    else if (!isVisible(el)) pass = false;

    gateCache.set(el, pass);
    return pass;
  }

  // ================================================================ 遍历

  /** 走一趟所有该检查的文本节点。cb(node, text) */
  function walkTextNodes(cb) {
    const root = document.body || document.documentElement;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        // 没有拉丁字母的节点(纯空白、纯标点、纯 CJK)直接丢,省掉后面全部开销
        if (!text || text.length < 3 || !/[A-Za-z]/.test(text)) {
          return NodeFilter.FILTER_REJECT;
        }
        const el = node.parentElement;
        if (!el || !elementPasses(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) cb(n, n.nodeValue);
  }

  /**
   * 属性文本(看不见但用户期望被检查的那部分)。
   * 在位者的差评原文:"Misses basic spelling mistakes and certain areas
   * (e.g., subject lines)" —— 实测 title/alt/placeholder/aria-label 4/4 全抓到。
   * cb(element, attrName, value)
   */
  function walkAttributes(cb) {
    const sel = P.ATTRS.map(a => '[' + a + ']').join(',');
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      // 属性也过跳过标签与语言门(<option title> 之类不查)
      if (el.closest(P.SKIP_SELECTOR)) continue;
      if (!P.isEnglishElement(el)) continue;
      for (const a of P.ATTRS) {
        if (!el.hasAttribute(a)) continue;
        const v = el.getAttribute(a);
        if (v && /[A-Za-z]/.test(v)) cb(el, a, v);
      }
    }
    // <title> 元素本身:它的文字显示在浏览器标签栏,不在页面里,
    // 所以它被排除在可见文本之外(SKIP_TAGS 含 title),在这里单独扫。
    // 不这么做的话同一个词会被「正文」和「属性」各报一次(实测踩过)。
    // ⚠️ 宿主元素传 null:<title> 在页面上**没有位置**,画不了框。
    //    这里不能传 document.documentElement —— 那会让 paint() 在整个页面上
    //    糊一个巨大的琥珀虚线框。它只出现在 popup 列表里,这是对的。
    const titleEl = document.querySelector('title');
    if (titleEl && titleEl.textContent && /[A-Za-z]/.test(titleEl.textContent)) {
      const htmlLang = document.documentElement.getAttribute('lang') || '';
      if (P.isEnglish(htmlLang)) cb(null, 'title', titleEl.textContent);
    }
  }

  // ================================================================ 扫描主流程

  async function scan() {
    clear();
    gateCache = new WeakMap();

    const tStart = performance.now();

    // ---- 第一趟:只收唯一候选词。不存偏移,不建 Range。
    const unique = new Set();
    const skipStats = Object.create(null);
    let candidateTokens = 0;
    const bump = reason => { skipStats[reason] = (skipStats[reason] || 0) + 1; };

    // ⭐ 顺手记下「有候选词的文本节点」。第二趟只需要遍历这个数组,
    //    不必再完整走一遍 DOM(TreeWalker + 元素闸门 + checkVisibility)。
    //    存的只是节点引用(8.7 万词页面上约几千个),不是偏移量 ——
    //    偏移量才是当初必须走两趟的原因(6.5 万个 {node,start,end} 太占内存)。
    const candidateNodes = [];

    walkTextNodes((node, text) => {
      const toks = P.collectTokens(text, bump);
      if (!toks.length) return;
      candidateTokens += toks.length;
      candidateNodes.push(node);
      for (const t of toks) unique.add(t.word);
    });

    const attrSeen = [];   // [{el, attr, value, words:Set}]
    walkAttributes((el, attr, value) => {
      const toks = P.collectTokens(value, bump);
      if (!toks.length) return;
      const words = new Set();
      for (const t of toks) { unique.add(t.word); words.add(t.word); }
      candidateTokens += toks.length;
      attrSeen.push({ el, attr, value, words });
    });

    const walkMs = performance.now() - tStart;
    const words = [...unique];

    // ---- 一条消息批量送查。逐词发能慢两个数量级(开销全在序列化)。
    const tMsg = performance.now();
    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: 'CHECK', words });
    } catch (err) {
      return { ok: false, error: '扩展已重新加载,请刷新页面后重试(' + err.message + ')' };
    }
    const roundTripMs = performance.now() - tMsg;

    if (!reply || !reply.ok) {
      return { ok: false, error: (reply && reply.error) || '词典没能加载' };
    }

    const bad = new Set(reply.misspelled);

    // ---- 第二趟:只为真错词建 Range。通常只有几十个词。
    //
    // ⚠️ 两处曾经很浪费,2026-08-17 实测 pass2 = 144ms 之后改掉的:
    //   ① 原来又完整走了一遍 DOM。现在只遍历第一趟记下的 candidateNodes ——
    //      省掉整棵树的 TreeWalker + 元素闸门 + checkVisibility。
    //   ② 原来对**每个有候选词的节点**都算裁剪祖先链,而 clippingAncestors()
    //      会沿祖先链逐层调 getComputedStyle:8.7 万词页面上约 3000 个候选节点
    //      × 深度 ~15 = **约 45,000 次 getComputedStyle**。
    //      而真正需要裁剪链的只有那几十个真错词所在的节点。
    //      现在改成**命中真错词才算**,并按父元素缓存。
    const tPass2 = performance.now();
    const byWord = new Map();   // word -> {word, hits:[{range,clippers}], count}
    if (bad.size) {
      const clipCache = new Map();   // Element -> Element[] 同一父元素只算一次
      for (const node of candidateNodes) {
        const text = node.nodeValue;
        if (!text) continue;                       // 两趟之间节点变了(SPA)
        const toks = P.collectTokens(text);
        let clippers = null;                       // 懒算:命中才算
        for (const t of toks) {
          if (!bad.has(t.word)) continue;
          if (clippers === null) {
            const parent = node.parentElement;
            clippers = clipCache.get(parent);
            if (clippers === undefined) {
              clippers = clippingAncestors(parent);
              clipCache.set(parent, clippers);
            }
          }
          let entry = byWord.get(t.word);
          if (!entry) { entry = { word: t.word, hits: [], count: 0 }; byWord.set(t.word, entry); }
          const r = document.createRange();
          try {
            r.setStart(node, t.start);
            r.setEnd(node, t.end);
          } catch (_) { continue; }   // 节点在两趟之间变了,跳过这一个
          entry.hits.push({ range: r, clippers });
          entry.count++;
        }
      }
    }
    const pass2Ms = performance.now() - tPass2;

    // ---- 组装 findings
    findings = [];
    let id = 0;
    for (const entry of [...byWord.values()].sort(byCountDesc)) {
      findings.push({
        id: id++, kind: 'prose', word: entry.word,
        count: entry.count, hits: entry.hits, el: null, attr: null, snippet: null
      });
    }
    for (const a of attrSeen) {
      for (const w of a.words) {
        if (!bad.has(w)) continue;
        findings.push({
          id: id++, kind: 'attr', word: w, count: 1, hits: [],
          el: a.el, attr: a.attr, snippet: truncate(a.value, 90),
          clippers: a.el ? clippingAncestors(a.el) : []
        });
      }
    }

    paint();

    // 字体加载会改变行盒位置 → 字体就绪后再重算一次,几乎零成本的保险。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (findings.length) paint(); }).catch(() => {});
    }

    const htmlLang = document.documentElement.getAttribute('lang') || '';

    return {
      ok: true,
      pageLang: htmlLang,
      pageLangIsEnglish: P.isEnglish(htmlLang),
      stats: {
        totalTokens: candidateTokens + sumValues(skipStats),
        checked: candidateTokens,
        uniqueChecked: words.length,
        skipStats,
        proseIssues: findings.filter(f => f.kind === 'prose').reduce((n, f) => n + f.count, 0),
        attrIssues: findings.filter(f => f.kind === 'attr').length,
        uniqueIssues: new Set(findings.map(f => f.word)).size
      },
      findings: findings.map(f => ({
        id: f.id, kind: f.kind, word: f.word, count: f.count,
        attr: f.attr, snippet: f.snippet
      })),
      timing: {
        walkMs: Math.round(walkMs),
        pass2Ms: Math.round(pass2Ms),
        roundTripMs: Math.round(roundTripMs),
        // ⚠️ paint 以前**没有被量过** —— 2026-08-17 在 8.7 万词页面上
        //    total 4753ms 里有 1768ms 对不上账,补了这一项才定位到读写交错。
        paintMs: Math.round(lastPaintMs),
        totalMs: Math.round(performance.now() - tStart),
        worker: reply.timing
      }
    };
  }

  function byCountDesc(a, b) {
    return b.count - a.count || a.word.localeCompare(b.word);
  }
  function sumValues(o) {
    let s = 0;
    for (const k in o) s += o[k];
    return s;
  }
  function truncate(s, n) {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ================================================================ 高亮层

  const LAYER_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer {
  position: absolute; top: 0; left: 0; width: 0; height: 0;
  pointer-events: none;
  z-index: 2147483647;
  font: 12px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;
}
.mark {
  position: absolute;
  pointer-events: auto;
  cursor: pointer;
  background: rgba(220, 38, 38, 0.13);
  border-bottom: 2px solid rgba(220, 38, 38, 0.85);
  border-radius: 2px;
}
.mark:hover { background: rgba(220, 38, 38, 0.26); }
.mark.flash { animation: sp-flash 1.1s ease-out 2; }
@keyframes sp-flash {
  0%, 100% { background: rgba(220, 38, 38, 0.13); }
  50% { background: rgba(250, 204, 21, 0.75); }
}
.box {
  position: absolute;
  pointer-events: auto;
  cursor: pointer;
  border: 2px dashed rgba(217, 119, 6, 0.9);
  border-radius: 3px;
  background: rgba(217, 119, 6, 0.07);
}
.box .tag {
  position: absolute; top: -18px; left: 0;
  background: rgba(217, 119, 6, 0.95); color: #fff;
  padding: 1px 5px; border-radius: 3px;
  font-size: 10px; white-space: nowrap;
}
.pop {
  position: absolute;
  pointer-events: auto;
  min-width: 190px; max-width: 300px;
  background: #1e2430; color: #e8eaed;
  border: 1px solid #3a4354; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,.45);
  padding: 9px 10px;
}
.pop .head {
  display: flex; align-items: baseline; gap: 6px;
  margin-bottom: 7px; padding-bottom: 6px; border-bottom: 1px solid #333c4d;
}
.pop .bad { color: #ff8a8a; font-weight: 600; text-decoration: underline wavy #ff8a8a; }
.pop .hint { color: #8b93a3; font-size: 10px; margin-left: auto; }
.pop .sugs { display: flex; flex-wrap: wrap; gap: 5px; }
.pop .sug {
  background: #2b3444; border: 1px solid #3f4a5e; color: #dfe4ea;
  border-radius: 5px; padding: 3px 8px; cursor: pointer; font-size: 12px;
}
.pop .sug:hover { background: #37455c; border-color: #5a6b86; }
.pop .none { color: #8b93a3; font-style: italic; }
.pop .close {
  position: absolute; top: 4px; right: 6px;
  color: #8b93a3; cursor: pointer; font-size: 14px; line-height: 1;
}
.pop .close:hover { color: #fff; }
.pop .foot { margin-top: 7px; color: #8b93a3; font-size: 10px; }
`;

  function ensureLayer() {
    if (layer && layer.isConnected) return;

    const old = document.getElementById(HOST_ID);
    if (old) old.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    // host 本身零尺寸、不挡事件。挂在 documentElement 上而不是 body 上,
    // 因为很多页面给 body 设了 position:relative,那会改变绝对定位的包含块。
    host.setAttribute('style',
      'all:initial;position:absolute;top:0;left:0;width:0;height:0;' +
      'margin:0;padding:0;border:0;pointer-events:none;');
    document.documentElement.appendChild(host);

    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = LAYER_CSS;
    layer = document.createElement('div');
    layer.className = 'layer';
    shadow.append(style, layer);

    // ⭐ 原点校正:不管页面把包含块搞成什么样,host 自己的 rect 就是「0,0 实际落在哪」。
    //    之后所有标记都相对这个原点定位 → 页面 CSS 再怪也不会整体偏移。
    const hr = host.getBoundingClientRect();
    originX = hr.left + window.scrollX;
    originY = hr.top + window.scrollY;

    // ⚠️ 点击监听注册在**这里**,不在 paint() 里 —— paint() 会被 resize 反复调用,
    //    注册在那边的话每次 resize 都会多挂一个监听,点一下标记就发两遍
    //    SUGGEST 请求、弹窗闪。事件委托到 layer 上,标记每次重画都是新元素也照样生效。
    layer.addEventListener('click', onMarkClick);
  }

  /**
   * ⭐ 找出一个元素头上所有会**裁剪**它的祖先(overflow 不是 visible 的)。
   *
   * 2026-08-15 第二轮实测暴露的问题:标记层挂在 documentElement 上,
   * **不受任何容器的 overflow 裁剪**。所以当一段文字滚出它所在的滚动框时,
   * 文字被框裁掉看不见了,而红标却跟着文字的坐标飘到框外面,
   * 盖在无关内容上 —— 用户看到的就是「一根红条飘在标题上」。
   *
   * 第一轮我把这个现象误判成「重绘没跟上」,加了 scroll 监听 —— 重绘其实一直是对的,
   * 真正缺的是**裁剪**。(顺带说明 scroll 监听那一步没白加:没有它,
   * 滚动时连位置都不会更新。两者都需要。)
   *
   * 裁剪链在一次扫描内不会变,所以扫描时算一次存起来,重绘时只做 rect 求交。
   */
  function clippingAncestors(el) {
    const out = [];
    let node = el;
    while (node && node !== document.documentElement && node !== document.body) {
      const cs = getComputedStyle(node);
      // overflow-x / overflow-y 要分开看:CSS 里一个是 hidden 另一个是 visible 时,
      // 浏览器会把 visible 那个强制成 auto,简写属性反映不出来。
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(node);
      node = node.parentElement;
    }
    return out;
  }

  /**
   * 把一个视口矩形逐个与裁剪祖先求交。完全被裁掉就返回 null(这个标记不该画)。
   * 部分露出就返回被裁短的矩形 —— 半个词滚进框里时红线也只画露出的那半个。
   *
   * @param {Map<Element,DOMRect>} cache 一次重绘内的裁剪框缓存。
   *   同一个滚动容器往往裁着几十个标记,rect 在一次重绘内不会变 ——
   *   不缓存的话就是 N×depth 次 getBoundingClientRect。
   */
  function clipToAncestors(rect, clippers, cache) {
    if (!clippers || !clippers.length) return rect;
    let l = rect.left, t = rect.top, r = rect.right, b = rect.bottom;
    for (const c of clippers) {
      let cb = cache.get(c);
      if (cb === undefined) { cb = c.getBoundingClientRect(); cache.set(c, cb); }
      if (cb.left > l) l = cb.left;
      if (cb.top > t) t = cb.top;
      if (cb.right < r) r = cb.right;
      if (cb.bottom < b) b = cb.bottom;
      if (r - l < 1 || b - t < 1) return null;
    }
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }

  /** 上一次 paint() 的耗时,进 popup 的耗时明细。以前这一段是**不可见**的。 */
  let lastPaintMs = 0;

  /**
   * 由 findings 里的 Range 重算并重画全部标记。resize / 内部滚动 / 字体就绪后也调它。
   *
   * ⚠️⚠️ **严格分成「纯读」和「纯写」两个阶段,别把它们混回去。**
   *
   * 2026-08-17 真机实测在 8.7 万词的页面上量到 total 4753ms,而所有已量项加起来
   * 只有 2985ms —— **1768ms(37%)不知去向**。补上 paint 计时后定位到这里。
   *
   * 病因是**读写交错触发的强制重排(layout thrashing)**:
   *     getClientRects()  → 读,强制浏览器算 layout
   *     appendChild(mark) → 写,让刚算好的 layout 失效
   *     下一轮的读 → 又强制算一次
   * 每个标记一次强制重排。小页面上忽略不计,8.7 万词的页面上每次重排都很贵,
   * 几十次乘起来就是 1.7 秒。
   *
   * 拆开之后:所有 getClientRects / getBoundingClientRect 在阶段 A 一次性做完
   * (只触发一次 layout),阶段 B 全部写进 DocumentFragment 最后一次挂上
   * (只触发一次 layout)。从 O(N) 次重排降到 2 次。
   */
  function paint() {
    if (!findings.length) return;
    ensureLayer();

    const t0 = performance.now();
    const sx = window.scrollX;
    const sy = window.scrollY;

    // ── 阶段 A:纯读。算完全部几何量,期间**一个字节的 DOM 都不写**。
    const clipCache = new Map();
    const plan = [];
    for (const f of findings) {
      if (f.kind === 'prose') {
        for (const hit of f.hits) {
          const rects = hit.range.getClientRects();
          for (const raw of rects) {
            if (raw.width < 1 || raw.height < 1) continue;
            // ⭐ 被滚动容器裁掉的部分不画 —— 否则红标会飘到框外面去
            const rect = clipToAncestors(raw, hit.clippers, clipCache);
            if (!rect) continue;
            plan.push({
              box: false, id: f.id,
              left: rect.left + sx - originX, top: rect.top + sy - originY,
              width: rect.width, height: rect.height, tag: null
            });
          }
        }
      } else if (f.kind === 'attr' && f.el && f.el.isConnected) {
        // 属性文本没法在页面里划出字符范围(它不在文本流里),
        // 所以给宿主元素画个虚线框 + 标签,告诉用户「这个元素的 alt 里有错字」。
        const raw = f.el.getBoundingClientRect();
        if (raw.width < 2 || raw.height < 2) continue;
        const rect = clipToAncestors(raw, f.clippers, clipCache);
        if (!rect) continue;
        plan.push({
          box: true, id: f.id,
          left: rect.left + sx - originX, top: rect.top + sy - originY,
          width: rect.width, height: rect.height,
          tag: f.attr + ': ' + f.word
        });
      }
    }

    // ── 阶段 B:纯写。建进 fragment,最后一次性挂上,**期间不再读任何几何量**。
    const frag = document.createDocumentFragment();
    const placedTags = [];   // 属性标签的碰撞避让占位,纯几何,不读 DOM
    for (const p of plan) {
      const el = document.createElement('div');
      el.className = p.box ? 'box' : 'mark';
      el.dataset.id = String(p.id);
      el.style.left = p.left + 'px';
      el.style.top = p.top + 'px';
      el.style.width = p.width + 'px';
      el.style.height = p.height + 'px';
      if (p.tag) {
        const tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = p.tag;
        // ⭐ 标签要避让 —— 2026-08-15 用户实测报出来的 bug:
        //    <button aria-label> 和它右边的 <span title> 挨在一起,
        //    两个标签都钉在各自框的左上角,于是**横向重叠互相遮挡**,
        //    页面上只看得到 "aria-l" 这种被截断的半截字。
        //    宽度按字符数估,纯算术,不测量 DOM —— 否则又回到读写交错。
        tag.style.top = tagOffset(p.left, p.top, p.tag, p.height, placedTags) + 'px';
        el.appendChild(tag);
      }
      frag.appendChild(el);
    }
    layer.textContent = '';
    layer.appendChild(frag);
    popover = null;

    lastPaintMs = performance.now() - t0;
  }

  /**
   * 给属性标签找一个不和别人重叠的纵向位置,返回相对宿主框的 top 偏移(px)。
   * 宽度按字符数估(标签是 10px 字号 + 5px 内边距),不需要精确 —— 只要够避让。
   */
  function tagOffset(boxLeft, boxTop, text, boxHeight, placed) {
    const w = text.length * 5.6 + 12;
    const h = 15;
    const step = 16;
    for (let lvl = 0; lvl < 6; lvl++) {
      const top = boxTop - 18 - lvl * step;
      // 抬到页面顶部外面就没意义了,改放到框下面
      if (top < 0) break;
      const r = { l: boxLeft, r: boxLeft + w, t: top, b: top + h };
      const hit = placed.some(p => r.r > p.l && r.l < p.r && r.b > p.t && r.t < p.b);
      if (!hit) { placed.push(r); return top - boxTop; }
    }
    // 上方挤满(或贴着页面顶边)→ 放到框下面,同样做一次避让
    for (let lvl = 0; lvl < 6; lvl++) {
      const top = boxTop + boxHeight + 2 + lvl * step;
      const r = { l: boxLeft, r: boxLeft + w, t: top, b: top + h };
      const hit = placed.some(p => r.r > p.l && r.l < p.r && r.b > p.t && r.t < p.b);
      if (!hit) { placed.push(r); return top - boxTop; }
    }
    return -18;
  }

  function clear() {
    findings = [];
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
    shadow = layer = popover = null;
  }

  // ================================================================ 建议弹窗

  async function onMarkClick(ev) {
    const target = ev.target.closest ? ev.target.closest('.mark,.box') : null;
    if (!target) return;
    ev.preventDefault();
    ev.stopPropagation();

    const f = findings.find(x => x.id === Number(target.dataset.id));
    if (!f) return;

    const left = parseFloat(target.style.left);
    const top = parseFloat(target.style.top) + parseFloat(target.style.height) + 6;
    showPopover(f, left, top, null);   // 先弹出来占位,建议异步填

    let sug = [];
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SUGGEST', word: f.word });
      if (r && r.ok) sug = r.suggestions || [];
    } catch (_) { /* 扩展被重载了,当没有建议处理 */ }
    showPopover(f, left, top, sug);
  }

  function showPopover(f, left, top, suggestions) {
    if (popover) popover.remove();
    ensureLayer();

    popover = document.createElement('div');
    popover.className = 'pop';
    popover.style.left = Math.max(0, left) + 'px';
    popover.style.top = top + 'px';

    const head = document.createElement('div');
    head.className = 'head';
    const bad = document.createElement('span');
    bad.className = 'bad';
    bad.textContent = f.word;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = f.kind === 'attr' ? f.attr : (f.count + '×');
    head.append(bad, hint);

    const sugs = document.createElement('div');
    sugs.className = 'sugs';
    if (suggestions === null) {
      const s = document.createElement('span');
      s.className = 'none';
      s.textContent = 'looking up…';
      sugs.appendChild(s);
    } else if (!suggestions.length) {
      const s = document.createElement('span');
      s.className = 'none';
      s.textContent = 'no suggestion';
      sugs.appendChild(s);
    } else {
      for (const w of suggestions) {
        const b = document.createElement('div');
        b.className = 'sug';
        b.textContent = w;
        b.title = 'click to copy';
        b.addEventListener('click', () => copyText(w, b));
        sugs.appendChild(b);
      }
    }

    const close = document.createElement('div');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', () => { popover.remove(); popover = null; });

    const foot = document.createElement('div');
    foot.className = 'foot';
    // 说清楚我们不改页面 —— 这是产品定位,不是偷懒
    foot.textContent = f.kind === 'attr'
      ? 'in the ' + f.attr + ' attribute · click a word to copy'
      : 'click a word to copy · this page is never modified';

    popover.append(close, head, sugs, foot);
    layer.appendChild(popover);
  }

  async function copyText(text, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '✓ ' + old;
      setTimeout(() => { btn.textContent = old; }, 900);
    };
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch (_) {
      // clipboard API 被页面策略挡住时的退路
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('style', 'position:fixed;top:-9999px;opacity:0;');
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (__) { /* 放弃 */ }
      ta.remove();
    }
  }

  // ================================================================ 跳转

  function jumpTo(id) {
    const f = findings.find(x => x.id === Number(id));
    if (!f) return false;

    // ⭐ 用 scrollIntoView 而不是手算 window.scrollTo:
    //    错字可能在一个内部滚动容器里(甚至嵌套好几层),手算只能滚页面,
    //    滚不到容器内部 —— 用户点了列表却什么也没看到。
    //    scrollIntoView 会把**沿途每一层可滚动祖先**都滚到位,一步到位。
    //    (它只滚动,不改 DOM,符合「不碰页面」的原则。)
    let target = null;
    if (f.kind === 'prose' && f.hits.length) {
      const sc = f.hits[0].range.startContainer;
      target = sc.nodeType === 1 ? sc : sc.parentElement;
    } else if (f.el && f.el.isConnected) {
      target = f.el;
    }
    if (!target) return false;

    try {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    } catch (_) {
      target.scrollIntoView();   // 老浏览器不认 options 形式
    }

    // 滚动结束后重画 + 闪一下 —— 页面上错字可能很小,不闪一下用户找不到
    setTimeout(() => {
      paint();
      const m = layer && layer.querySelector('[data-id="' + f.id + '"]');
      if (m) { m.classList.add('flash'); setTimeout(() => m.classList.remove('flash'), 2400); }
    }, 480);
    return true;
  }

  // ================================================================ 事件

  let resizeTimer = null;
  let scrollRaf = 0;

  function onResize() {
    // resize 会改变行盒换行位置 → Range 的 rect 全变。防抖后重画。
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (findings.length) paint(); }, 160);
  }

  // ⭐ 内部滚动容器的漂移修正(2026-08-15 用户实测报出来的)。
  //
  //    **页面本身滚动不需要做任何事** —— 标记用的是文档坐标,浏览器自己带着它滚,
  //    零成本。这是这套方案最大的好处,不能丢。
  //
  //    但页面里那些自己带滚动条的容器(overflow:auto/scroll)不一样:
  //    在框内滚动时,容器里的文字动了、文档坐标却没变 → 红标留在原地,
  //    看起来像一根飘在空白处的红条,**像坏了一样**。
  //
  //    修法:scroll 事件本身不冒泡,但可以在 document 上用**捕获阶段**收到
  //    任意后代元素的 scroll。收到之后按 rAF 节流重画。
  //    过滤掉 target 是页面/文档的那些 —— 那是页面滚动,不需要重算。
  function onAnyScroll(ev) {
    if (!findings.length) return;
    const t = ev.target;
    if (t === document || t === document.documentElement || t === document.body) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; paint(); });
  }

  function onKeydown(ev) {
    if (ev.key === 'Escape' && popover) { popover.remove(); popover = null; }
  }

  function onRuntimeMessage(msg, _sender, respond) {
    (async () => {
      try {
        switch (msg && msg.type) {
          case 'SCAN':
            respond(await scan());
            break;
          case 'CLEAR':
            clear();
            respond({ ok: true });
            break;
          case 'JUMP':
            respond({ ok: jumpTo(msg.id) });
            break;
          // ⭐ PING:让 popup 先问一句「你在吗」,在就跳过 executeScript。
          //    2026-08-17 实测:8.7 万词页面上 inject 要 **1038ms**,
          //    而重复扫描时那 1 秒是纯浪费(脚本已经在页面里了)。
          //    版本号一起回去 —— 扩展更新过就必须重新注入。
          case 'PING':
            respond({ ok: true, version: VERSION, hasResults: findings.length > 0 });
            break;
          default:
            respond({ ok: false, error: 'unknown message: ' + (msg && msg.type) });
        }
      } catch (err) {
        console.error('[spell] content handler failed', err);
        respond({ ok: false, error: String((err && err.message) || err) });
      }
    })();
    return true;   // MV3:异步响应必须返回 true
  }

  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
  window.addEventListener('keydown', onKeydown, true);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  /**
   * 把这一份实例拆干净。**只有上面那个「接管」分支会调它。**
   * 拆的时候 chrome.runtime 可能已经失效(扩展被重载了),所以全都包 try。
   */
  function destroy() {
    try { window.removeEventListener('resize', onResize); } catch (_) {}
    try { document.removeEventListener('scroll', onAnyScroll, { capture: true }); } catch (_) {}
    try { window.removeEventListener('keydown', onKeydown, true); } catch (_) {}
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
    try { clearTimeout(resizeTimer); } catch (_) {}
    try { if (scrollRaf) cancelAnimationFrame(scrollRaf); } catch (_) {}
    try { clear(); } catch (_) {}
  }

  // 把自己登记上去,供下一次注入接管。
  globalThis.__OFFLINE_SPELL_CHECK__ = { version: VERSION, destroy };
})();
