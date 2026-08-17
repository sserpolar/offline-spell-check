/*
 * nspell affix parser — ESM port
 *
 * ⚠️ 这是**移植代码,不是我写的算法**。上游:
 *   nspell 2.1.5 (MIT) — https://github.com/wooorm/nspell
 *   本文件 = 上游 `lib/util/affix.js` + `lib/util/rule-codes.js` 逐行照搬
 *
 * 为什么要移植而不是直接 npm 引:
 *   nspell 是 CommonJS(`require`),MV3 的 service worker 只吃 ES module。
 *   上游自带 browserify 打包脚本,但打出来是 bundle 包装 —— 会放弃
 *   「submit your code as authored」这个审核加速位(上个扩展靠它跑通的)。
 *   所以手工转 ESM:零构建链、源码可读、审核员能直接读。
 *
 * 改动清单(全部改动都在这里列出,除此之外一字未改):
 *   1. `require`/`module.exports` → `import`/`export`
 *   2. `doc.toString('utf8')` → `String(doc)`
 *      —— 浏览器里词典由 `fetch().text()` 得到,本来就是字符串;
 *         `'abc'.toString('utf8')` 也返回 'abc',语义等价
 *   3. 删掉 eslint / istanbul 注释指令
 *   变量风格(var / while(++i) 循环)刻意保持原样,方便日后与上游 diff 对账。
 *
 * 移植正确性由 `spell-probe/port_check.mjs` 差分验证:
 *   对全部 49,568 个词条 + 注入错字,移植版与原版 correct()/suggest() 必须逐词相同。
 */

// ---------------------------------------------------------------- rule-codes
// 上游 lib/util/rule-codes.js
const NO_CODES = [];

// Parse rule codes.
export function parseRuleCodes(flags, value) {
  var index = 0;
  var result;

  if (!value) return NO_CODES;

  if (flags.FLAG === 'long') {
    // Creating an array of the right length immediately
    // avoiding resizes and using memory more efficiently
    result = new Array(Math.ceil(value.length / 2));

    while (index < value.length) {
      result[index / 2] = value.slice(index, index + 2);
      index += 2;
    }

    return result;
  }

  return value.split(flags.FLAG === 'num' ? ',' : '');
}

// ---------------------------------------------------------------- affix
// 上游 lib/util/affix.js
var push = [].push;

// Relative frequencies of letters in the English language.
var alphabet = 'etaoinshrdlcumwfgypbvkjxqz'.split('');

// Expressions.
var whiteSpaceExpression = /\s+/;

// Defaults.
var defaultKeyboardLayout = [
  'qwertzuop',
  'yxcvbnm',
  'qaw',
  'say',
  'wse',
  'dsx',
  'sy',
  'edr',
  'fdc',
  'dx',
  'rft',
  'gfv',
  'fc',
  'tgz',
  'hgb',
  'gv',
  'zhu',
  'jhn',
  'hb',
  'uji',
  'kjm',
  'jn',
  'iko',
  'lkm'
];

// Parse an affix file.
export default function affix(doc) {
  var rules = Object.create(null);
  var compoundRuleCodes = Object.create(null);
  var flags = Object.create(null);
  var replacementTable = [];
  var conversion = {in: [], out: []};
  var compoundRules = [];
  var aff = String(doc);
  var lines = [];
  var last = 0;
  var index = aff.indexOf('\n');
  var parts;
  var line;
  var ruleType;
  var count;
  var remove;
  var add;
  var source;
  var entry;
  var position;
  var rule;
  var value;
  var offset;
  var character;

  flags.KEY = [];

  // Process the affix buffer into a list of applicable lines.
  while (index > -1) {
    pushLine(aff.slice(last, index));
    last = index + 1;
    index = aff.indexOf('\n', last);
  }

  pushLine(aff.slice(last));

  // Process each line.
  index = -1;

  while (++index < lines.length) {
    line = lines[index];
    parts = line.split(whiteSpaceExpression);
    ruleType = parts[0];

    if (ruleType === 'REP') {
      count = index + parseInt(parts[1], 10);

      while (++index <= count) {
        parts = lines[index].split(whiteSpaceExpression);
        replacementTable.push([parts[1], parts[2]]);
      }

      index--;
    } else if (ruleType === 'ICONV' || ruleType === 'OCONV') {
      count = index + parseInt(parts[1], 10);
      entry = conversion[ruleType === 'ICONV' ? 'in' : 'out'];

      while (++index <= count) {
        parts = lines[index].split(whiteSpaceExpression);
        entry.push([new RegExp(parts[1], 'g'), parts[2]]);
      }

      index--;
    } else if (ruleType === 'COMPOUNDRULE') {
      count = index + parseInt(parts[1], 10);

      while (++index <= count) {
        rule = lines[index].split(whiteSpaceExpression)[1];
        position = -1;

        compoundRules.push(rule);

        while (++position < rule.length) {
          compoundRuleCodes[rule.charAt(position)] = [];
        }
      }

      index--;
    } else if (ruleType === 'PFX' || ruleType === 'SFX') {
      count = index + parseInt(parts[3], 10);

      rule = {
        type: ruleType,
        combineable: parts[2] === 'Y',
        entries: []
      };

      rules[parts[1]] = rule;

      while (++index <= count) {
        parts = lines[index].split(whiteSpaceExpression);
        remove = parts[2];
        add = parts[3].split('/');
        source = parts[4];

        entry = {
          add: '',
          remove: '',
          match: '',
          continuation: parseRuleCodes(flags, add[1])
        };

        if (add && add[0] !== '0') {
          entry.add = add[0];
        }

        try {
          if (remove !== '0') {
            entry.remove = ruleType === 'SFX' ? end(remove) : remove;
          }

          if (source && source !== '.') {
            entry.match = ruleType === 'SFX' ? end(source) : start(source);
          }
        } catch (_) {
          // Ignore invalid regex patterns.
          entry = null;
        }

        if (entry) {
          rule.entries.push(entry);
        }
      }

      index--;
    } else if (ruleType === 'TRY') {
      source = parts[1];
      offset = -1;
      value = [];

      while (++offset < source.length) {
        character = source.charAt(offset);

        if (character.toLowerCase() === character) {
          value.push(character);
        }
      }

      // Some dictionaries may forget a character.
      // Notably `en` forgets `j`, `x`, and `y`.
      offset = -1;

      while (++offset < alphabet.length) {
        if (source.indexOf(alphabet[offset]) < 0) {
          value.push(alphabet[offset]);
        }
      }

      flags[ruleType] = value;
    } else if (ruleType === 'KEY') {
      push.apply(flags[ruleType], parts[1].split('|'));
    } else if (ruleType === 'COMPOUNDMIN') {
      flags[ruleType] = Number(parts[1]);
    } else if (ruleType === 'ONLYINCOMPOUND') {
      // If we add this ONLYINCOMPOUND flag to `compoundRuleCodes`, then
      // `parseDic` will do the work of saving the list of words that are
      // compound-only.
      flags[ruleType] = parts[1];
      compoundRuleCodes[parts[1]] = [];
    } else if (
      ruleType === 'FLAG' ||
      ruleType === 'KEEPCASE' ||
      ruleType === 'NOSUGGEST' ||
      ruleType === 'WORDCHARS'
    ) {
      flags[ruleType] = parts[1];
    } else {
      // Default handling: set them for now.
      flags[ruleType] = parts[1];
    }
  }

  // Default for `COMPOUNDMIN` is `3`.
  // See `man 4 hunspell`.
  if (isNaN(flags.COMPOUNDMIN)) {
    flags.COMPOUNDMIN = 3;
  }

  if (!flags.KEY.length) {
    flags.KEY = defaultKeyboardLayout;
  }

  if (!flags.TRY) {
    flags.TRY = alphabet.concat();
  }

  if (!flags.KEEPCASE) {
    flags.KEEPCASE = false;
  }

  return {
    compoundRuleCodes: compoundRuleCodes,
    replacementTable: replacementTable,
    conversion: conversion,
    compoundRules: compoundRules,
    rules: rules,
    flags: flags
  };

  function pushLine(line) {
    line = line.trim();

    // Hash can be a valid flag, so we only discard line that starts with it.
    if (line && line.charCodeAt(0) !== 35 /* `#` */) {
      lines.push(line);
    }
  }
}

// Wrap the `source` of an expression-like string so that it matches only at
// the end of a value.
function end(source) {
  return new RegExp(source + '$');
}

// Wrap the `source` of an expression-like string so that it matches only at
// the start of a value.
function start(source) {
  return new RegExp('^' + source);
}
