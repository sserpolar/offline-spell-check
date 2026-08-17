/*
 * pipeline.js — 拼写检查的过滤流水线【单一真源】
 *
 * 副业军师 2026-08-14 起草(spell-probe/pipeline.mjs) → 2026-08-15 升级为产品真源。
 *
 * ⭐⭐ 这个文件是**唯一一份**过滤逻辑。改这里 = 同时改产品行为和实测口径。
 *
 * 双消费格式(故意这么写的,别改成 ESM):
 *   ① 扩展的 content script —— 由 chrome.scripting.executeScript 当 **classic
 *      script** 注入(MV3 的 executeScript 不吃 ES module),读 globalThis.SpellPipeline
 *   ② Node 的实测 probe —— `spell-probe/pipeline.mjs` 是个 8 行 shim,
 *      `import` 本文件取副作用,再把 globalThis.SpellPipeline 拆成命名导出
 *
 *   ⇒ 产品跑的字节和 fp_probe / recall_probe 量出来的字节**是同一份**。
 *      实测数字(误报 0.05% / 非词召回 18/18)因此可以直接搬到产品上,
 *      不需要「产品里应该也差不多」这种祈祷。
 *
 * ------------------------------------------------------------------ 实测背书
 * 下面每条规则后面的数字都是在 4 个真实英文技术文档页(约 6.5 万词)
 * 上量出来的(2026-08-14 首轮 / 2026-08-15 补两道闸),不是估的。详见 spell-probe/RESULTS.md。
 *
 * ⛔ 别再试「剥后缀查词根」处理派生词(programmatically / deallocates)。
 *    已实测否掉:误报只从 0.09% 降到 0.08%(当时基线,现基线 0.05%),但**召回从 18/18 掉到 16/18**,
 *    放过了 occured(→occur)、begining(→begin)。机理:漏双写错误恰好发生在
 *    词根与后缀的接合处,剥后缀正好把它绕过去。**设计上根本不成立,不是调参问题。**
 *    领域派生词的唯一安全解是扩充下面的 TECH 表。
 */

(function (root) {
  'use strict';

  // ================================================================ 跳过的标签
  // code/pre/kbd/samp/var/tt:代码不该被拼写检查(实测:代码块内注入的错字 0/2 命中,
  //   这是**期望结果**)。
  // nav/select/option/footer:语言切换器和站点导航的重灾区 —— 实测残留误报
  //   Deutsch / Brasil 全出自这里(Portugu / Espa 是分词碎片,已由碎片闸单独解决)。
  // ⚠️ 但跳标签只是近似!产品里真正拦住多语言页的是下面的**逐元素语言门**。
  // title/head:<title> 的文字显示在浏览器标签栏而非页面里,由属性扫描单独处理,
  //   否则同一个词会被「正文」和「属性」各报一次(实测踩过:dashbord 重复计入)。
  var SKIP_TAGS = ['script', 'style', 'code', 'pre', 'kbd', 'samp', 'var', 'tt',
                   'math', 'svg', 'nav', 'select', 'option', 'footer',
                   'title', 'head'];

  // DOM 版用的选择器形式(content script 里 el.closest(SKIP_SELECTOR))。
  // 从同一个数组生成,不另写一份。
  var SKIP_SELECTOR = SKIP_TAGS.join(',');

  // ================================================================ 技术术语表
  // 通用拼写检查扩展都没有这一层,它本身就是差异点的实质内容。
  // 实测命中 3,230 次 —— 没有它,误报率从 0.05% 涨回 0.55% 量级。
  // ⚠️ 这是**持续维护项,不是一次性的**。每轮实测都还能捞出新词。
  //    加词的正确姿势:先确认它真的是术语而不是在掩盖一个分词 bug
  //    (2026-08-14 就把 iso/koi/pre/apis 摘出去过 —— 那四个是分词 bug 装成术语)。
  //
  // ⭐ 2026-08-15 第二批(下方空行之后那一块,133 词)。
  //    起因:用户在测试页第 ⑥ 节实测撞到 `Encodings` 被标红。
  //    诊断:`encodings` 是**合法英语词,SCOWL 标准档没收** —— 和
  //    programmatically / deallocates / realtime 同一类。这一类在 RESULTS.md
  //    里占残留误报的近一半,而它的唯一安全解就是扩表
  //    (「剥后缀查词根」已实测否掉:召回 18/18 → 16/18)。
  //    做法:写了 `spell-probe/dict_gap.mjs` 反向查 —— 主动喂 300 个技术文档
  //    高频词问词典「哪些你不认」,一次捞出 138 个。
  //
  //    ⚠️ 那 138 个我**逐个眼过**,故意剔掉了 5 个:
  //      · `themable`   → 正确拼法是 themeable。VS Code 文档里那个是真拼错的,
  //                       报它才对。收进来等于用白名单掩盖一个真错字。
  //      · `dismissable`→ 正确拼法是 dismissible。同上。
  //      · `unlinted` / `unchunked` / `introspectable` → 生造词,不会出现,加了只是噪音。
  //    **加错一个词 = 那个拼法永远不会被报成错字。** 这条纪律比多收几个词重要。
  var TECH = new Set(`uri uris url urls thenable readonly webview webviews args argv
tooltip tooltips breakpoint breakpoints json jsonc yaml yml toml serializer serializers
mutator mutators whitespace falsy truthy cwd viewport viewports eol codebase stringify
stringified stringifyable evaluatable pseudoterminal namespace namespaces workspace
workspaces filesystem middleware runtime runtimes async await callback callbacks
boolean enum enums iterable iterables promisify debounce throttle memoize
lint linter linters linting minify minified bundler bundlers transpile transpiled
polyfill polyfills changelog readme metadata favicon iframe iframes
config configs configure param params kwargs regex regexes substring substrings
lowercase uppercase camelcase snakecase kebabcase
plugin plugins hostname localhost devtools frontend backend fullstack
auth authenticate oauth jwt cors csrf xhr ajax websocket websockets
repo repos monorepo submodule submodules changeset changesets
deprecate deprecated deprecations refactor refactoring
unregister unregisters unregistered subscribe unsubscribe
cancelled canceled behaviour behavior serializable deserialize
renderer renderers viewlet viewlets matcher matchers
uint int32 float64 nullable optional overridable
scaffold scaffolding boilerplate
npm pnpm yarn nodejs typescript javascript
knip eslint prettier webpack vite rollup babel jest vitest playwright
vscode github gitlab microsoft chromium mozilla
statusbar lightbulb rgba rgb hsl hsla pty tabstop tabstops quickpick quickinput
mimetype mimetypes tokenizer tokenizers tokenization getter getters setter setters
bitmask multiline subfolder subfolders implementor implementors callbackfn
embedder templating templated theming walkthrough walkthroughs codespaces
tslint struct structs init dev cmd utf mkdirp folderless
unpersisted codebases monorepos refactorings hostings selectable dialogs
signalling subtype subtypes supertypes formatter formatters unfocus rescan
prerelease prereleases untitled unsaved autosave autoclose autocomplete
stdin stdout stderr nvm asdf zsh bash pwsh unix
sourcemap sourcemaps treeview treeviews statusbaritem
esm cjs umd iife dts tsx jsx scm vsix crx tsc typeof
gzip brotli minifier uglify basename dirname ctime mtime
outdent unindented desugared arity stringifier stringifying syntaxes severities
unhandled untrusted errored checkboxes unchecks sandboxed requestor filetree
quickfix preselect prepended unsets reauthenticate inlining descendent
iconified streamable codeblock csharp jupyter css jpg png gpt dir
mv2 mv3 manifestv2 manifestv3 api html env lifecycle esc

encodings decodings programmatically deserializes deserializing deserialized
deserialization reserialize deallocate deallocates deallocated deallocating
deallocation deduplicate deduplicates deduplicated deduplication dedupe dedupes
deduped cancellable cancelable cancelling realtime deprioritize deprioritized
reprioritize actioned enablement themeable stacktrace stacktraces backtick
backticks semver viewtype labelled modelled rerender rerenders rerendered
rerendering prefetch prefetches prefetched prefetching rehydrate rehydrates
rehydration rehydrating memoized memoization debounced composable composables
observables injectable injectables nullish rewrap denormalize denormalized
reauthentication allowlist allowlists blocklist blocklists timezones scaffolded
transpiler transpilers minifies minifying idempotency idempotently retryable
backoff revalidate revalidated revalidation dereference dereferences dereferenced
instantiation tokenize tokenizes tokenized untokenized detokenize unsanitized
singleline inlined prepends uncheck resizable draggable droppable scrollable
hoverable focusable sortable pinnable dismissible performant misconfigured
misconfiguration undeployed hardcode hardcoded hardcoding rethrow rethrows
rethrown polyfilled upsert upserts upserted webhook webhooks overscroll
snapshotting downlevel subclassed superclass metaclass awaitable unwritable
autocompletion autocompleted autocompleting inspectable backpressure observability`
    .split(/\s+/).filter(Boolean));

  // 连字符复合词会被分词切成两段,前缀那段单独看都不是英语单词。
  // 实据:"pre-existing" / "pre-filled" → 切出的 pre 被报错。实测命中 122 次。
  var HYPHEN_AFFIX = new Set(`pre post non re un sub multi inter intra cross semi
quasi anti co de over under self well half mid bi tri auto pseudo micro macro
proto meta re-`.split(/\s+/).filter(Boolean));

  // ================================================================ 分词
  // ⚠️ 数字必须纳进 token。否则 iso88591 / koi8r / utf16le 会被切成
  //    iso / koi / utf 这些纯字母碎片送检(2026-08-14 用 context_probe 抓到实据)。
  //    纳进来之后,下面的 has-digit 规则天然覆盖这一整类(实测命中 95 次)。
  //
  // ⚠️ 弯引号 U+2019(’)必须纳进 token —— 2026-08-15 写测试页时抓到:
  //    真实网页里 isn’t / user’s / doesn’t 用的是弯引号而不是 ASCII 撇号。
  //    不纳进来的话 isn’t 被切成 isn + t,而 **isn 不在词典里 → 误报**,
  //    doesn / wasn / couldn / shouldn 全是同一类。弯引号在网页上是常态,
  //    这个漏洞会天天触发。
  //    纳进来之后:isn’t 整体送检,nspell 的 aff 里有 `ICONV ’ '`,
  //    它自己会把弯引号归一成 ASCII 撇号再查表 → 命中 isn't。
  // 用函数返回新对象,避免 lastIndex 在多处 exec 之间串味。
  function tokenRe() { return /[A-Za-z][A-Za-z0-9'’]*/g; }

  // 我们的分词器只认 ASCII 字母。遇到别的字母(é ñ ç ü 中日韩…)就断词,
  // 于是切出**半个词**。这类碎片不能拿去查词典 —— 见 collectTokens 里的「碎片闸」。
  var NON_ASCII_LETTER = /\p{L}/u;
  function isLetterWeCannotRead(ch) {
    return !!ch && NON_ASCII_LETTER.test(ch) && !/[A-Za-z]/.test(ch);
  }

  // ================================================================ 非散文片段
  // URL / 邮箱 / 带点标识符 / 路径 —— 不剥的话 https、api、html 这些碎片会被送检。
  // ⭐ 只有这一份正则清单。字符串版的 stripNonProse 和 DOM 版的 nonProseRanges
  //    都从它派生,所以「产品剥掉了什么」与「实测剥掉了什么」严格一致。
  var NON_PROSE = [
    /https?:\/\/[^\s<]+/gi,                 // URL
    /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,        // 邮箱
    /[\w-]+(?:\.[\w-]+){1,}/g,              // foo.bar.baz / index.html
    /[\w-]*\/[\w\/-]+/g                     // src/main / /api/v1
  ];

  /**
   * 找出文本里所有「非散文」区间(左闭右开),已按 start 排序并合并重叠。
   * DOM 版用它:**不能真的删字符**,否则高亮偏移就全错了 —— 改成标记区间,
   * 分词时落在区间里的 token 直接丢掉。效果与删除等价,偏移不变。
   */
  function nonProseRanges(text) {
    var raw = [];
    for (var i = 0; i < NON_PROSE.length; i++) {
      var re = new RegExp(NON_PROSE[i].source, NON_PROSE[i].flags);
      var m;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        raw.push([m.index, m.index + m[0].length]);
      }
    }
    if (!raw.length) return raw;
    raw.sort(function (a, b) { return a[0] - b[0]; });
    var out = [raw[0]];
    for (var j = 1; j < raw.length; j++) {
      var last = out[out.length - 1];
      if (raw[j][0] <= last[1]) { if (raw[j][1] > last[1]) last[1] = raw[j][1]; }
      else out.push(raw[j]);
    }
    return out;
  }

  /** 字符串版:把非散文区间换成等长空格。等长 = 偏移不变,给 probe 用也安全。 */
  function stripNonProse(text) {
    var ranges = nonProseRanges(text);
    if (!ranges.length) return text;
    var out = '';
    var cursor = 0;
    for (var i = 0; i < ranges.length; i++) {
      out += text.slice(cursor, ranges[i][0]);
      out += ' '.repeat(ranges[i][1] - ranges[i][0]);
      cursor = ranges[i][1];
    }
    return out + text.slice(cursor);
  }

  // ================================================================ 归一化
  // 剥首尾引号(ASCII ' 与弯引号 ’)+ 剥所有格 's。
  // 不剥的话 webview's、Uri's、user’s 全被报错。
  // ⭐ 返回**区间**而不只是词:高亮要画在归一化后的那几个字符上,
  //    否则 "dashbord's" 会连所有格一起标红,看着像多标了。
  function isQuote(ch) { return ch === "'" || ch === '’'; }

  function normalizeSpan(raw) {
    var start = 0;
    var end = raw.length;
    while (start < end && isQuote(raw.charAt(start))) start++;
    while (end > start && isQuote(raw.charAt(end - 1))) end--;
    var core = raw.slice(start, end);
    if (/['’]s$/i.test(core)) end -= 2;
    return { word: raw.slice(start, end), start: start, end: end };
  }

  /** 与旧 pipeline.mjs 的 normalize() 行为完全一致,由 normalizeSpan 派生。 */
  function normalize(raw) { return normalizeSpan(raw).word; }

  // ================================================================ 跳过规则
  // 这几条就是产品的核心:少一条,误报就爆(第 1 轮没有它们时 4.50%)。
  // 返回 null = 这个词要送去查;返回字符串 = 跳过的原因(用于统计与调试)。
  function shouldSkip(w) {
    if (w.length < 3) return 'too-short';
    if (/\d/.test(w)) return 'has-digit';                 // 实测 95 次
    if (/^[A-Z]{2,}$/.test(w)) return 'acronym';
    if (/^[A-Z]{2,}s$/.test(w)) return 'acronym-plural';  // APIs / URLs / IDs,实测 15 次
    if (HYPHEN_AFFIX.has(w.toLowerCase())) return 'hyphen-affix';  // 实测 122 次
    if (/[a-z][A-Z]/.test(w)) return 'camelCase';
    if (/^[A-Z][a-z]+[A-Z]/.test(w)) return 'PascalCase';
    if (/_/.test(w)) return 'snake_case';
    if (TECH.has(w.toLowerCase())) return 'tech-term';    // 实测 3,230 次
    return null;
  }

  // ================================================================ 语言门
  // 2026-08-14 踩到:Chrome 扩展文档页被服务成德语(没送 accept-language),
  // 整页德语被英语词典查 → 那一页误报率 **75.48%**。
  // 没有这一步,任何非英语页面都会被标红刷屏。这几乎肯定是在位者掉到 3 分档的原因之一。
  function isEnglish(lang) { return !lang || /^en/i.test(lang); }

  /** 字符串版:只看整页 <html lang>。probe 用。 */
  function pageLang(html) {
    return (html.match(/<html[^>]*lang=["']?([a-zA-Z-]{2,7})/) || [])[1] || '';
  }

  /**
   * ⭐ DOM 版逐元素语言门 —— **产品里必须用这个,不能只用整页 pageLang**。
   * 多语言站的语言切换器就在页内(<li lang="de">Deutsch</li>),整页门拦不住它。
   * closest('[lang]') 同时覆盖两种情况:找到 <html lang> 就是整页门,
   * 找到更近的祖先就是元素级门。找不到任何 lang → 当英语处理(与 isEnglish('') 一致)。
   */
  function isEnglishElement(el) {
    if (!el || !el.closest) return true;
    var holder = el.closest('[lang]');
    if (!holder) return true;
    return isEnglish(holder.getAttribute('lang') || '');
  }

  // ================================================================ 属性文本
  // 在位者的差评原文:"Misses basic spelling mistakes and certain areas
  // (e.g., subject lines)" —— 用户期望覆盖这类看不见的文本。实测 4/4 全抓到。
  var ATTRS = ['title', 'alt', 'placeholder', 'aria-label'];

  /** 字符串版属性扫描。probe 用。 */
  function attributeText(html) {
    var out = [];
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      var re = new RegExp('\\b' + a + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'gi');
      var m;
      while ((m = re.exec(html))) {
        out.push({ attr: a, text: decodeEntities(m[1] != null ? m[1] : (m[2] || '')) });
      }
    }
    var t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) out.push({ attr: 'title-el', text: decodeEntities(t[1]) });
    return out;
  }

  /** 字符串版可见文本提取。probe 用(浏览器里走 DOM,不用这个)。 */
  function visibleText(html) {
    var h = html;
    h = h.replace(/<!--[\s\S]*?-->/g, ' ');
    for (var i = 0; i < SKIP_TAGS.length; i++) {
      h = h.replace(new RegExp('<' + SKIP_TAGS[i] + '\\b[^>]*>[\\s\\S]*?<\\/' + SKIP_TAGS[i] + '>', 'gi'), ' ');
    }
    h = h.replace(/<[^>]+>/g, ' ');
    h = decodeEntities(h);
    return stripNonProse(h).replace(/\s+/g, ' ');
  }

  function decodeEntities(h) {
    return h.replace(/&(?:nbsp|#160);/g, ' ')
            .replace(/&(?:amp|#38);/g, '&')
            .replace(/&(?:lt|#60);/g, '<')
            .replace(/&(?:gt|#62);/g, '>')
            .replace(/&(?:quot|#34);/g, '"')
            .replace(/&(?:#39|apos|rsquo|#8217);/g, "'")
            .replace(/&[a-z#0-9]{2,8};/gi, ' ');
  }

  // ================================================================ 检查一段文本
  /**
   * 字符串版(probe 用)。**内部直接调 collectTokens** ——
   * 这样「实测量的分词」和「产品跑的分词」在字面上就是同一条路径,不可能漂移。
   * @returns {{checked:number, flagged:string[], skipStats:Object, total:number}}
   */
  function checkText(text, spell) {
    var skipStats = {};
    var toks = collectTokens(text, function (r) {
      skipStats[r] = (skipStats[r] || 0) + 1;
    });
    var flagged = [];
    for (var i = 0; i < toks.length; i++) {
      var w = toks[i].word;
      if (spell.correct(w)) continue;
      if (spell.correct(w.toLowerCase())) continue;   // 句首大写
      flagged.push(w);
    }
    var skipped = 0;
    for (var k in skipStats) skipped += skipStats[k];
    return {
      checked: toks.length,
      flagged: flagged,
      skipStats: skipStats,
      total: toks.length + skipped
    };
  }

  // ================================================================ DOM 版:带偏移分词
  /**
   * ⭐ 产品的热路径,也是上面 checkText 的底座 —— **全项目唯一的分词实现**。
   *    把一段文本切成候选词,带上偏移量,好让 content script 之后能用
   *    document.createRange() 精确定位画高亮。
   *
   * @param {string} text
   * @param {(reason:string)=>void} [onSkip] 可选:统计跳过原因
   * @returns {Array<{word:string, start:number, end:number}>} 需要送去查的候选词
   */
  function collectTokens(text, onSkip) {
    var masked = nonProseRanges(text);
    var mi = 0;
    var re = tokenRe();
    var out = [];
    var m;
    while ((m = re.exec(text))) {
      var tokStart = m.index;
      var tokEnd = tokStart + m[0].length;

      // 落在非散文区间里的 token 直接丢。masked 已排序,用游标线性推进。
      while (mi < masked.length && masked[mi][1] <= tokStart) mi++;
      if (mi < masked.length && tokStart >= masked[mi][0] && tokStart < masked[mi][1]) {
        if (onSkip) onSkip('non-prose');
        continue;
      }

      // ⭐ 碎片闸(2026-08-15 加)。我们的字符类只认 ASCII 字母,
      //    遇到 é ñ ç ü 或中日韩字符就断词 → 切出**半个词**,
      //    拿去查词典必然报错。
      //    实据:RESULTS.md 里残留误报 `Espa`(Español 被 ñ 切断)、
      //    `Portugu`(Português 被 ê 切断)、`ais`(Français 被 ç 切断)。
      //    当时归因成「语言切换器残留」—— 那只对了一半:语言门恰好覆盖了那几个实例,
      //    但**机理是断词**。英文页上的 café → caf、résumé → sum 语言门救不了。
      //    正解:只要 token 紧邻一个我们读不了的字母,它就是碎片,不判。
      if (isLetterWeCannotRead(text.charAt(tokStart - 1)) ||
          isLetterWeCannotRead(text.charAt(tokEnd))) {
        if (onSkip) onSkip('letter-fragment');
        continue;
      }

      var span = normalizeSpan(m[0]);
      if (!span.word) { if (onSkip) onSkip('empty'); continue; }
      var reason = shouldSkip(span.word);
      if (reason) { if (onSkip) onSkip(reason); continue; }
      out.push({
        word: span.word,
        start: tokStart + span.start,
        end: tokStart + span.end
      });
    }
    return out;
  }

  // ================================================================ 导出
  root.SpellPipeline = {
    // 共享常量
    SKIP_TAGS: SKIP_TAGS,
    SKIP_SELECTOR: SKIP_SELECTOR,
    TECH: TECH,
    HYPHEN_AFFIX: HYPHEN_AFFIX,
    ATTRS: ATTRS,
    NON_PROSE: NON_PROSE,
    // 规则(产品与 probe 共用的那几条)
    tokenRe: tokenRe,
    normalize: normalize,
    normalizeSpan: normalizeSpan,
    shouldSkip: shouldSkip,
    nonProseRanges: nonProseRanges,
    stripNonProse: stripNonProse,
    isEnglish: isEnglish,
    // 字符串 API(probe)
    visibleText: visibleText,
    attributeText: attributeText,
    pageLang: pageLang,
    checkText: checkText,
    // DOM API(产品)
    isEnglishElement: isEnglishElement,
    collectTokens: collectTokens
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
