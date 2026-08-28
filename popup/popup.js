/*
 * popup/popup.js — 触发扫描、显示结果、显示耗时明细
 *
 * ════════════════════════════════════════════════════════════════════
 * 权限设计:为什么这里不用 tabs,也不用 host permissions
 * ════════════════════════════════════════════════════════════════════
 * 在位者(Spell Checker for Chrome,100k 装机 / 3.46 分)申请了 `tabs`,
 * chrome-stats 因此把它标成 **Critical** 风险,原话:
 *   "Grants access to browser tabs, which can be used to track user browsing habits"
 * 我们的详情页不会有这句话 —— 这是可以在商店描述里明写的对比,也是文案卖点。
 *
 * 做法:
 *   · `chrome.tabs.query()` **不需要** tabs 权限就能调 —— 只是拿不到 url/title
 *     这类敏感字段。而我们只要 tab.id。
 *     (用户点了工具栏图标之后,activeTab 会临时授予当前这一个标签页的访问权,
 *      此时 url 也能读到,仅用于给出「这个页面 Chrome 不让扩展跑」这类友好提示。)
 *   · 脚本用 `chrome.scripting.executeScript` **按需注入**,
 *     而不是在 manifest 里声明 content_scripts ——
 *     声明式 content_scripts 必须写 matches,那等于要 host permissions,
 *     用户安装时就会看到「读取您在所有网站上的数据」那句警告。
 *     按需注入 + activeTab = **那句警告根本不出现**。
 * ════════════════════════════════════════════════════════════════════
 */

const $ = id => document.getElementById(id);

const els = {
  status: $('status'),
  summary: $('summary'),
  nIssues: $('n-issues'),
  nAttr: $('n-attr'),
  nChecked: $('n-checked'),
  list: $('list'),
  empty: $('empty'),
  emptySub: $('empty-sub'),
  rescan: $('rescan'),
  clear: $('clear'),
  timing: $('timing')
};

let tabId = null;

/**
 * 注入的两个文件。顺序有意义:pipeline.js 先挂 globalThis.SpellPipeline。
 *
 * ⚠️ **必须是前导 `/` 的根绝对路径。** 2026-08-24 在真 Firefox 里踩到:
 * 写成相对路径 `'content/scan.js'` 时,Firefox 把它按**调用方文档**(popup/popup.html)
 * 解析成 `moz-extension://<id>/popup/content/scan.js` —— 那个文件不存在,
 * 报出来的错还是含混的 `result is non-structured-clonable data`,不是「文件找不到」。
 * Chrome 是按扩展根解析的,所以这个差异在 Chrome 上永远暴露不出来。
 * 前导 `/` 在两个浏览器里都明确表示扩展根,是唯一两边都对的写法。
 */
const FILES = ['/shared/pipeline.js', '/content/scan.js'];
const MY_VERSION = chrome.runtime.getManifest().version;

/**
 * ⭐ 是不是「解压加载」的开发版本?
 *
 * Chrome 给**商店安装**的扩展在 getManifest() 里塞一个 `update_url`
 * (指向 clients2.google.com 的更新服务),**解压加载的没有**。
 * 这是判别开发/生产最省的办法 —— 不需要任何权限,一行搞定。
 *
 * 用途:底部那三行耗时明细**只在开发时显示**。
 *   · 留着的价值:用户报「在我这页很慢」时,这是唯一的诊断入口;
 *     而 `ok` / `! gap N` 自检抓出过一个 1768ms 的黑洞
 *   · 去掉的理由:用户不关心,看着像半成品,而且大页面显示 `total 529ms`
 *     只会让人以为它慢
 *   ⇒ 折中:开发看得见,商店用户看不见,数据照样进 console.log(见 render())
 *
 * ⚠️ 出商店截图时:截图是从解压加载的开发版截的,所以这三行**会出现**。
 *    要么把 popup 底部裁掉,要么把下面这个常量临时改成 false 再截。
 */
const SHOW_TIMING = !('update_url' in chrome.runtime.getManifest());

/**
 * ⭐ 确保页面里有脚本 —— **但能不注入就不注入**。
 *
 * 2026-08-17 真机实测:8.7 万词的页面上 `executeScript` 要 **1038ms**
 * (测试页只要 81ms)。重复扫描时这一秒是纯浪费 —— 脚本本来就在页面里。
 *
 * 所以先 PING 一句:在 + 版本一致 → 直接跳过。
 * PING 失败的两种情况都该注入:
 *   ① 这个标签页还没注入过
 *   ② 扩展刚重载/更新过,页面里那份旧脚本的 runtime 已失效(消息发不到它)
 * 版本号比对是为了扩展更新后强制换新代码。
 *
 * @returns {Promise<boolean>} true = 跳过了注入
 */
async function ensureInjected(id) {
  try {
    const pong = await chrome.tabs.sendMessage(id, { type: 'PING' });
    if (pong && pong.ok && pong.version === MY_VERSION) return true;
  } catch (_) {
    // 没注入过,或旧实例已死 —— 往下走注入
  }
  await chrome.scripting.executeScript({ target: { tabId: id }, files: FILES });
  return false;
}

// ---------------------------------------------------------------- 工具

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = 'status' + (kind ? ' ' + kind : '');
}

function fmt(n) { return Number(n).toLocaleString('en-US'); }

/**
 * 把浏览器的原始错误翻成人话。
 *
 * ⚠️ **必须同时认 Chrome 和 Firefox 两套措辞。** 2026-08-28 在**上架的正式版**上踩到:
 * 在受限页面(当时是 AMO 自己的页面)点图标,Firefox 抛的是
 * `Missing host permission for the tab` —— 下面原来的正则**一条都匹配不上**,
 * 于是原样漏到界面上,用户看到的字面是「缺少 host 权限」。
 * ⛔ **这跟本扩展的核心卖点正好相反**(不申请 host permissions、
 * 安装时不出现「读取您在所有网站上的数据」),最容易被读成「权限没给全 / 坏了」→ 一星。
 * Chrome 在同类页面上抛的是完全不同的话(`Cannot access a chrome:// URL` /
 * `The extensions gallery cannot be scripted.`),所以这个漏洞**只有 Firefox 能暴露**。
 *
 * ⚠️ **文案里不许写死浏览器名。** 同一批字节在 Chrome / Edge / Firefox 三家跑,
 * 原来那句 "Chrome does not allow…" 在 Edge 和 Firefox 用户眼里是别人家的浏览器。
 * 现在的写法**正反都说**:能用的是普通 http(s) 页,不能用的是浏览器自己的页面 /
 * 扩展页 / 各家的扩展商店 —— 用户看完不需要再猜。
 *
 * ⚠️ **`file://` 那条必须排在受限页面之前。** Chrome 的 file 错误里带 `file://` 字样,
 * 但 Firefox 的 file 错误很可能同样只说 `Missing host permission for the tab` ——
 * 顺序反了会把「文件访问没开」误报成「这类页面一律不让跑」,把可解决的问题说成死路。
 */
function friendlyError(msg) {
  const m = String(msg || '');

  // ① 本地文件 —— 必须排在 ② 之前(见上面注释)
  if (/file:\/\//i.test(m)) {
    return 'Local files are not checked unless you allow it: open this extension\'s ' +
           'details page and turn on access to file URLs.';
  }

  // ② 浏览器不许任何扩展碰的页面。Chrome / Edge / Firefox 三套措辞都收在这里。
  //    Chrome/Edge: "Cannot access a chrome:// URL" · "The extensions gallery cannot be scripted."
  //    Firefox:     "Missing host permission for the tab"(about: 页面与 AMO 等受限域都是这句)
  if (/chrome:\/\/|edge:\/\/|about:[a-z]|chrome-extension:\/\/|moz-extension:\/\/|extensions? gallery|Cannot access a chrome|Missing host permission/i.test(m)) {
    return 'Only ordinary http:// and https:// pages can be checked. Browsers block every ' +
           'extension on their own pages, on extension pages and in their add-on stores — ' +
           'this page is one of those.';
  }

  if (/Cannot access contents/i.test(m)) {
    return 'This page cannot be read. Try an ordinary http:// or https:// page.';
  }
  if (/Receiving end does not exist/i.test(m)) {
    return 'Reload the page once (the extension was just installed or updated), then try again.';
  }
  return m;
}

// ---------------------------------------------------------------- 主流程

async function getTabId() {
  if (tabId != null) return tabId;
  // 不需要 tabs 权限:我们只取 id。
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  tabId = tab.id;
  return tabId;
}

async function run() {
  els.rescan.disabled = true;
  els.list.textContent = '';
  els.summary.classList.add('hidden');
  els.empty.classList.add('hidden');
  setStatus('Scanning…');

  const tStart = performance.now();

  let id;
  try {
    id = await getTabId();
  } catch (err) {
    setStatus(friendlyError(err.message), 'error');
    els.rescan.disabled = false;
    return;
  }
  const tabMs = performance.now() - tStart;

  // ---- 注入(能复用就复用,见 ensureInjected 的注释)
  const tInject = performance.now();
  let injectSkipped = false;
  try {
    injectSkipped = await ensureInjected(id);
  } catch (err) {
    setStatus(friendlyError(err.message), 'error');
    els.rescan.disabled = false;
    return;
  }
  const injectMs = performance.now() - tInject;

  // ---- 扫描
  const tScan = performance.now();
  let res;
  try {
    res = await chrome.tabs.sendMessage(id, { type: 'SCAN' });
  } catch (err) {
    setStatus(friendlyError(err.message), 'error');
    els.rescan.disabled = false;
    return;
  }
  const scanMs = performance.now() - tScan;

  const totalMs = performance.now() - tStart;
  els.rescan.disabled = false;

  if (!res || !res.ok) {
    setStatus(friendlyError(res && res.error) || 'Scan failed.', 'error');
    return;
  }

  render(res, { tabMs, injectMs, injectSkipped, scanMs, totalMs });
}

// ---------------------------------------------------------------- 渲染

function render(res, local) {
  const s = res.stats;

  els.nIssues.textContent = fmt(s.proseIssues);
  els.nAttr.textContent = fmt(s.attrIssues);
  els.nChecked.textContent = fmt(s.checked);
  els.summary.classList.remove('hidden');

  // 语言门的结果要告诉用户 —— 否则一个德语页面显示「0 个错字」会让人以为坏了。
  // 实测:不加语言门时,一个被服务成德语的页面误报率 75.48%。
  if (!res.pageLangIsEnglish) {
    setStatus('This page is marked lang="' + res.pageLang + '". ' +
              'Only English text is checked, so most of it was skipped.', 'warn');
  } else if (res.findings.length) {
    setStatus(s.uniqueIssues + ' distinct word' + (s.uniqueIssues === 1 ? '' : 's') +
              ' highlighted on the page. Click a row to jump to it.');
  } else {
    setStatus('Checked ' + fmt(s.checked) + ' words.');
  }

  if (!res.findings.length) {
    els.empty.classList.remove('hidden');
    els.emptySub.textContent =
      fmt(s.checked) + ' words checked, ' + fmt(s.uniqueChecked) + ' of them distinct. ' +
      'Code blocks, camelCase identifiers, acronyms and non-English elements were skipped.';
  } else {
    for (const f of res.findings) els.list.appendChild(row(f));
  }

  showTiming(res.timing, local);

  // 跳过规则的命中明细对调参有用,但对用户没意义 —— 丢控制台。
  // (耗时明细由 showTiming 自己打,那边还带 gap 自检。)
  console.log('[spell] skip stats', s.skipStats);
}

function row(f) {
  const el = document.createElement('div');
  el.className = 'item' + (f.kind === 'attr' ? ' attr' : '');

  const word = document.createElement('span');
  word.className = 'word';
  word.textContent = f.word;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = f.kind === 'attr'
    ? f.attr
    : f.count + '×';
  if (f.kind === 'attr') badge.title = f.snippet || '';

  el.append(word, badge);

  let loaded = false;
  el.addEventListener('click', async () => {
    // 点一下:页面滚到它 + 就地取建议(suggest 很贵,所以只在点的时候算)
    chrome.tabs.sendMessage(tabId, { type: 'JUMP', id: f.id }).catch(() => {});
    if (loaded) return;
    loaded = true;

    const box = document.createElement('div');
    box.className = 'sugs';
    const wait = document.createElement('span');
    wait.className = 'nosug';
    wait.textContent = 'looking up…';
    box.appendChild(wait);
    el.appendChild(box);

    let sug = [];
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SUGGEST', word: f.word });
      if (r && r.ok) sug = r.suggestions || [];
    } catch (_) { /* ignore */ }

    box.textContent = '';
    if (!sug.length) {
      const none = document.createElement('span');
      none.className = 'nosug';
      none.textContent = 'no suggestion';
      box.appendChild(none);
    } else {
      for (const w of sug) {
        const b = document.createElement('button');
        b.className = 'sug';
        b.textContent = w;
        b.title = 'copy';
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          navigator.clipboard.writeText(w).then(() => {
            const old = b.textContent;
            b.textContent = '✓ ' + old;
            setTimeout(() => { b.textContent = old; }, 900);
          }).catch(() => {});
        });
        box.appendChild(b);
      }
    }
  });

  return el;
}

/**
 * ⭐ 耗时明细 —— 「在真扩展里复量加载耗时」的量具。
 *
 * ⚠️⚠️ **这张表必须能算平到 0。**
 * 2026-08-17 在 8.7 万词的页面上量到 total 4753ms,而当时列出的各项加起来
 * 只有 2985ms —— **1768ms(37%)不知去向**,因为 paint() 压根没被计时。
 * 那正是上一轮「测试只报数量不报内容」的同类错误:**只量了自己想到的环节。**
 * 所以现在最后一行会算 gap,对不上就直接把差值显示出来。
 *
 * 分项(第二行是页面侧,第三行是 popup 侧):
 *   dict   = 词典 fetch + 解析(service worker 报的;warm 时是历史值,本次没付)
 *   walk   = 第一趟 DOM 遍历(收唯一候选词)
 *   ipc    = content→worker 往返 − 实付词典构建 − 查词
 *            = MV3 service worker 唤醒 + 消息序列化
 *   pass2  = 第二趟 DOM 遍历(只为真错词建 Range + 算裁剪祖先链)
 *   paint  = 画高亮(纯读算几何 + 纯写挂 DOM)。**以前不可见的就是这一项**
 *   lookup = 批量查词(0.x ms 量级 —— 查词从来不是瓶颈)
 *   inner  = 页面侧端到端
 *   tab    = chrome.tabs.query 拿 tabId
 *   inject = 注入两个文件;显示 (reused) 说明 PING 命中、这次没注入
 *   msg    = popup↔content 的 SCAN 消息开销 = scan 往返 − inner
 *   total  = 从点下到渲染前的墙上时间
 */
function showTiming(t, local) {
  const w = t.worker || {};
  const paidDict = w.dictionaryWasCold ? (w.totalMs || 0) : 0;
  const ipc = Math.max(0, Math.round(t.roundTripMs - paidDict - (w.lookupMs || 0)));

  const inner = t.totalMs || 0;
  const tab = Math.round(local.tabMs);
  const inject = Math.round(local.injectMs);
  const msg = Math.max(0, Math.round(local.scanMs - inner));
  const total = Math.round(local.totalMs);
  const gap = total - (tab + inject + msg + inner);

  // ⭐ 全额对账**永远**跑,并且总是进 console —— 即使界面上不显示。
  //    商店用户看不到那三行,但一旦有人报「在我这页很慢」,
  //    让他右键 popup → 检查 → Console,数据就在那儿。
  //    gap != 0 直接用 console.warn 叫出来:那意味着有时间没被任何一项量到,
  //    2026-08-17 就是这么发现 paint() 那 1768ms 黑洞的。
  console.log('[spell] timing', {
    dictMs: w.totalMs, dictFetchMs: w.fetchMs, dictParseMs: w.parseMs,
    dictWasCold: w.dictionaryWasCold,
    walkMs: t.walkMs, ipcMs: ipc, pass2Ms: t.pass2Ms, paintMs: t.paintMs,
    lookupMs: w.lookupMs, innerMs: inner,
    tabMs: tab, injectMs: inject, injectReused: !!local.injectSkipped,
    msgMs: msg, totalMs: total, gapMs: gap,
    distinctWordsSent: w.wordsChecked
  });
  if (Math.abs(gap) > 2) {
    console.warn('[spell] 耗时对不上账,有 ' + gap + 'ms 没被任何一项量到 —— 仪表盘有漏洞');
  }

  // 界面上只在开发版显示(见 SHOW_TIMING 的注释)
  if (!SHOW_TIMING) {
    els.timing.textContent = '';
    els.timing.title = '';
    return;
  }

  const line1 = 'dict ' + (w.totalMs || 0) + 'ms (fetch ' + (w.fetchMs || 0) +
                ' + parse ' + (w.parseMs || 0) + ') · ' +
                (w.dictionaryWasCold ? 'COLD build' : 'warm, reused');
  const line2 = 'walk ' + t.walkMs + ' · ipc ' + ipc + ' · pass2 ' + t.pass2Ms +
                ' · paint ' + t.paintMs + ' · lookup ' + (w.lookupMs || 0) +
                ' = inner ' + inner;
  const line3 = 'tab ' + tab + ' · inject ' + inject +
                (local.injectSkipped ? ' (reused)' : '') +
                ' · msg ' + msg + ' · total ' + total +
                (Math.abs(gap) > 2 ? '  ! gap ' + gap : '  ok');

  els.timing.textContent = '';
  els.timing.append(document.createTextNode(line1),
                    document.createElement('br'),
                    document.createTextNode(line2),
                    document.createElement('br'),
                    document.createTextNode(line3));
  // 用模板字符串写多行 tooltip —— 里面全是真实换行,不含任何转义序列。
  els.timing.title =
    `The numbers must add up: tab + inject + msg + inner = total.
If they do not, the line ends with "! gap N" — that is unmeasured time.

dict   = dictionary fetch + parse in the service worker
walk   = first DOM pass (collect distinct words)
ipc    = service-worker wake-up + message serialisation
pass2  = second DOM pass (ranges for real errors only)
paint  = drawing the highlight layer
inject = "(reused)" means the script was already in the page` +
    (w.wordsChecked != null
      ? `

distinct words sent to the worker: ${fmt(w.wordsChecked)}`
      : '');
}

// ---------------------------------------------------------------- 启动

els.rescan.addEventListener('click', run);

els.clear.addEventListener('click', async () => {
  try {
    const id = await getTabId();
    await chrome.tabs.sendMessage(id, { type: 'CLEAR' });
    els.list.textContent = '';
    els.summary.classList.add('hidden');
    els.empty.classList.add('hidden');
    setStatus('Highlights cleared.');
  } catch (err) {
    setStatus(friendlyError(err.message), 'error');
  }
});

// 预热:popup 一打开就让 service worker 开始建词典(不阻塞)。
// 用户读标题那几十毫秒里,100ms 的构建就已经跑完了 → 感知上是「瞬间」。
chrome.runtime.sendMessage({ type: 'WARMUP' }).catch(() => {});

// 打开即扫。点工具栏图标本身就是「用户主动触发」,再要求点一次按钮是多余的。
run();
