/*
 * nspell dictionary parser — ESM port
 *
 * ⚠️ 移植代码。上游 nspell 2.1.5 (MIT),本文件 = 以下三个上游文件逐行照搬:
 *   lib/util/apply.js · lib/util/add.js · lib/util/dictionary.js
 * 改动:仅模块语法 + `buf.toString('utf8')` → `String(buf)`。算法一字未改。
 *
 * ⏱️ **这里就是那 61ms**。实测(load_probe.mjs,7 轮中位数):
 *   读 index.aff + index.dic = 1ms,本文件的 parse = 61ms,堆内存 +20.7MB。
 *   61ms 的绝大部分花在下面 `add()` 里展开 affix 规则 —— 49,568 个词条
 *   每个都要按 PFX/SFX 规则生成全部派生形式塞进 `dict`。
 *   ⇒ 优化空间在这里(可预先序列化 dict),但 61ms 已经够快,v1.0 不动它。
 */

import { parseRuleCodes } from './affix.js';

var push = [].push;

var NO_RULES = [];

// ---------------------------------------------------------------- apply
// 上游 lib/util/apply.js
// Apply a rule.
function apply(value, rule, rules, words) {
  var index = -1;
  var entry;
  var next;
  var continuationRule;
  var continuation;
  var position;

  while (++index < rule.entries.length) {
    entry = rule.entries[index];
    continuation = entry.continuation;
    position = -1;

    if (!entry.match || entry.match.test(value)) {
      next = entry.remove ? value.replace(entry.remove, '') : value;
      next = rule.type === 'SFX' ? next + entry.add : entry.add + next;
      words.push(next);

      if (continuation && continuation.length) {
        while (++position < continuation.length) {
          continuationRule = rules[continuation[position]];

          if (continuationRule) {
            apply(next, continuationRule, rules, words);
          }
        }
      }
    }
  }

  return words;
}

// ---------------------------------------------------------------- add
// 上游 lib/util/add.js
// Add `rules` for `word` to the table.
function addRules(dict, word, rules) {
  var curr = dict[word];

  // Some dictionaries will list the same word multiple times with different
  // rule sets.
  if (word in dict) {
    if (curr === NO_RULES) {
      dict[word] = rules.concat();
    } else {
      push.apply(curr, rules);
    }
  } else {
    dict[word] = rules.concat();
  }
}

export function add(dict, word, codes, options) {
  var position = -1;
  var rule;
  var offset;
  var subposition;
  var suboffset;
  var combined;
  var newWords;
  var otherNewWords;

  // Compound words.
  if (
    !('NEEDAFFIX' in options.flags) ||
    codes.indexOf(options.flags.NEEDAFFIX) < 0
  ) {
    addRules(dict, word, codes);
  }

  while (++position < codes.length) {
    rule = options.rules[codes[position]];

    if (codes[position] in options.compoundRuleCodes) {
      options.compoundRuleCodes[codes[position]].push(word);
    }

    if (rule) {
      newWords = apply(word, rule, options.rules, []);
      offset = -1;

      while (++offset < newWords.length) {
        if (!(newWords[offset] in dict)) {
          dict[newWords[offset]] = NO_RULES;
        }

        if (rule.combineable) {
          subposition = position;

          while (++subposition < codes.length) {
            combined = options.rules[codes[subposition]];

            if (
              combined &&
              combined.combineable &&
              rule.type !== combined.type
            ) {
              otherNewWords = apply(
                newWords[offset],
                combined,
                options.rules,
                []
              );
              suboffset = -1;

              while (++suboffset < otherNewWords.length) {
                if (!(otherNewWords[suboffset] in dict)) {
                  dict[otherNewWords[suboffset]] = NO_RULES;
                }
              }
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------- dictionary
// 上游 lib/util/dictionary.js

// Expressions.
var whiteSpaceExpression = /\s/g;

// Parse a dictionary.
export default function parse(buf, options, dict) {
  // Parse as lines (ignoring the first line).
  var value = String(buf);
  var last = value.indexOf('\n') + 1;
  var index = value.indexOf('\n', last);

  while (index > -1) {
    // Some dictionaries use tabs as comments.
    if (value.charCodeAt(last) !== 9 /* `\t` */) {
      parseLine(value.slice(last, index), options, dict);
    }

    last = index + 1;
    index = value.indexOf('\n', last);
  }

  parseLine(value.slice(last), options, dict);
}

// Parse a line in dictionary.
function parseLine(line, options, dict) {
  var slashOffset = line.indexOf('/');
  var hashOffset = line.indexOf('#');
  var codes = '';
  var word;
  var result;

  // Find offsets.
  while (
    slashOffset > -1 &&
    line.charCodeAt(slashOffset - 1) === 92 /* `\` */
  ) {
    line = line.slice(0, slashOffset - 1) + line.slice(slashOffset);
    slashOffset = line.indexOf('/', slashOffset);
  }

  // Handle hash and slash offsets.
  // Note that hash can be a valid flag, so we should not just discard
  // everything after it.
  if (hashOffset > -1) {
    if (slashOffset > -1 && slashOffset < hashOffset) {
      word = line.slice(0, slashOffset);
      whiteSpaceExpression.lastIndex = slashOffset + 1;
      result = whiteSpaceExpression.exec(line);
      codes = line.slice(slashOffset + 1, result ? result.index : undefined);
    } else {
      word = line.slice(0, hashOffset);
    }
  } else if (slashOffset > -1) {
    word = line.slice(0, slashOffset);
    codes = line.slice(slashOffset + 1);
  } else {
    word = line;
  }

  word = word.trim();

  if (word) {
    add(dict, word, parseRuleCodes(options.flags, codes.trim()), options);
  }
}
