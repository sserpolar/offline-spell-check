/*
 * dict_gap.mjs — 查「SCOWL 词典漏收但技术文档里高频」的合法英语词
 *
 *
 * 为什么需要这个工具:
 *   BENCHMARK.md的残留误报里,**占比最大的一类**是
 *   「真英语词但 SCOWL 标准档没收」—— programmatically / deallocates /
 *   cancellable / deserializing / realtime / deduplicate …
 *
 *   这一类的唯一安全解是**扩充 TECH 表**(「剥后缀查词根」已实测否掉:
 *   召回从 18/18 掉到 16/18)。但靠 fp_probe 的残留列表一次一次捞太慢 ——
 *   fp_probe 只覆盖 4 个页面,真实用户会遇到的词多得多。
 *
 *   所以反过来做:主动喂一批技术文档高频词,问词典「哪些你不认」。
 *   不认的 + TECH 表也没有的,就是**产品会误报的词**。
 *
 * ⚠️ 加词前必须自己看一眼:确认它是**正确拼写的合法词**,
 *    不是某个真错字恰好的拼法。加错了 = 那个错字永远不会被报出来。
 *
 * 用法:  node dict_gap.mjs
 *        输出可直接贴进 ../shared/pipeline.js 的 TECH 表
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nspellPkg from 'nspell';
import P from './pipeline.mjs';

const NSpell = nspellPkg.default || nspellPkg;
const here = path.dirname(fileURLToPath(import.meta.url));
const D = path.join(here, '..', 'src', 'dict');
const spell = new NSpell(
  fs.readFileSync(path.join(D, 'index.aff'), 'utf8'),
  fs.readFileSync(path.join(D, 'index.dic'), 'utf8')
);

// 候选词来源:①「2026-08-15 实测第 ⑥ 题撞到的 Encodings」那一类
// ② fp_probe 残留列表里的漏收词 ③ 技术文档里的常见派生形式
// 加新词就往这里加,重跑即可。
const CANDIDATES = `
encoding encodings decoding decodings encoder encoders decoder decoders
programmatically programmatic deserialize deserializes deserializing deserialized deserialization
serialize serializes serializing serialized serialization reserialize
deallocate deallocates deallocated deallocating deallocation
reallocate reallocates deduplicate deduplicates deduplicated deduplication dedupe dedupes deduped
cancellable cancelable cancelling canceling
realtime deprioritize deprioritized prioritize prioritized reprioritize
actioned enablement themable themeable stacktrace stacktraces backtick backticks semver viewtype
labelled modelled
rerender rerenders rerendered rerendering prefetch prefetches prefetched prefetching
unfocused refocus rehydrate rehydrates rehydration rehydrating dehydrate
memoized memoization paginate paginates paginated pagination
throttled debounced composable composables observables injectable injectables
nullish unwrap unwraps unwrapped rewrap
normalize normalizes normalization denormalize denormalized
unauthenticated reauthenticate reauthentication
whitelist whitelists whitelisted blacklist blacklists blacklisted
allowlist allowlists blocklist blocklists
timestamp timestamps timezone timezones
scaffolded transpiler transpilers minifies minifying
idempotent idempotency idempotently
resubscribe resubscribes unsubscribed retryable backoff
invalidate invalidates invalidation revalidate revalidated revalidation
reformat reformatted prettified linted unlinted
dereference dereferences dereferenced instantiate instantiates instantiated instantiation
overridable overridden introspect introspection
tokenize tokenizes tokenized untokenized detokenize
sanitize sanitizes sanitized sanitizer sanitizers unsanitized
multiline singleline inlined outlined
prepend prepends prepended
uncheck unchecks unchecked recheck rechecked
collapsible expandable resizable draggable droppable scrollable clickable hoverable focusable
selectable searchable filterable sortable pinnable dismissable dismissible
performant misconfigured misconfiguration reconfigure reconfigured
undeployed redeploy redeployed redeploying rollback rollbacks
hardcode hardcoded hardcoding
uncaught rethrow rethrows rethrown
mocked stubbed polyfilled shimmed
upsert upserts upserted webhook webhooks
overscroll navigable snapshotting downlevel
subclassed superclass metaclass callable awaitable
writable unwritable
autocompletion autocompleted autocompleting
introspectable inspectable
chunked chunking unchunked
enqueue enqueues enqueued dequeue dequeues dequeued
backpressure
observability
`.split(/\s+/).filter(Boolean);

const uniq = [...new Set(CANDIDATES)];
const missingNoTech = [];
const missingHasTech = [];
const known = [];

for (const w of uniq) {
  const ok = spell.correct(w) || spell.correct(w.toLowerCase());
  if (ok) { known.push(w); continue; }
  if (P.TECH.has(w.toLowerCase())) missingHasTech.push(w);
  else missingNoTech.push(w);
}

const cols = (arr, n = 5, pad = 20) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push('  ' + arr.slice(i, i + n).map(w => w.padEnd(pad)).join('').trimEnd());
  }
  return out.join('\n');
};

console.log(`\n候选 ${uniq.length} 词。词典认识 ${known.length},漏收 ${uniq.length - known.length}。\n`);

console.log('🛑 【词典漏收 + TECH 表也没有】= 产品现在会误报这些词:');
console.log(cols(missingNoTech));
console.log(`\n   共 ${missingNoTech.length} 个。`);

console.log('\n✅ 【词典漏收 但 TECH 表已覆盖】= 已经不会误报:');
console.log(cols(missingHasTech));
console.log(`   共 ${missingHasTech.length} 个。`);

if (missingNoTech.length) {
  console.log('\n---- 可直接贴进 shared/pipeline.js 的 TECH 表(每行 8 个)----\n');
  for (let i = 0; i < missingNoTech.length; i += 8) {
    console.log(missingNoTech.slice(i, i + 8).map(w => w.toLowerCase()).join(' '));
  }
  console.log('\n⚠️ 贴之前逐个眼过一遍:确认每个都是**正确拼写**的合法词。');
  console.log('   加错一个 = 那个拼法永远不会被报成错字。');
}
