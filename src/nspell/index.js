/*
 * nspell — ESM port (entry point)
 *
 * ⚠️ 移植代码。上游 nspell 2.1.5 (MIT) — https://github.com/wooorm/nspell
 * 本文件 = 以下上游文件合并逐行照搬:
 *   lib/index.js · lib/correct.js · lib/spell.js · lib/add.js
 *   lib/remove.js · lib/personal.js · lib/word-characters.js · lib/dictionary.js
 *
 * 改动清单(仅此三条):
 *   1. require/module.exports → import/export
 *   2. **去掉 `is-buffer` 依赖**。上游用它判断 aff/dic 是不是 Node Buffer;
 *      浏览器里词典一律由 `fetch().text()` 得到,只可能是字符串。
 *      少一个依赖 = 少一个要审的第三方包。
 *   3. `buf.toString('utf8')` → `String(buf)`(personal.js 那处)
 *
 * 许可义务:`NSPELL-LICENSE.txt` 与本文件同目录,随包分发。
 *   词典的许可义务另算,见 `../dict/DICTIONARY-LICENSE.txt`(必须原文照搬,15.7 KB)。
 *
 * 用法(与上游 API 完全一致):
 *   const spell = new NSpell(affString, dicString);
 *   spell.correct('teh')   // → false
 *   spell.suggest('teh')   // → ['the', ...]
 */

import affix from './affix.js';
import parseDictionary, { add as pushWord } from './dictionary.js';
import form from './form.js';
import { flag } from './form.js';
import suggest from './suggest.js';

var NO_CODES = [];

// ---------------------------------------------------------------- constructor
// 上游 lib/index.js
export default function NSpell(aff, dic) {
  var index = -1;
  var dictionaries;

  if (!(this instanceof NSpell)) {
    return new NSpell(aff, dic);
  }

  if (typeof aff === 'string') {
    if (typeof dic === 'string') {
      dictionaries = [{dic: dic}];
    }
  } else if (aff) {
    if ('length' in aff) {
      dictionaries = aff;
      aff = aff[0] && aff[0].aff;
    } else {
      if (aff.dic) {
        dictionaries = [aff];
      }

      aff = aff.aff;
    }
  }

  if (!aff) {
    throw new Error('Missing `aff` in dictionary');
  }

  aff = affix(aff);

  this.data = Object.create(null);
  this.compoundRuleCodes = aff.compoundRuleCodes;
  this.replacementTable = aff.replacementTable;
  this.conversion = aff.conversion;
  this.compoundRules = aff.compoundRules;
  this.rules = aff.rules;
  this.flags = aff.flags;

  if (dictionaries) {
    while (++index < dictionaries.length) {
      if (dictionaries[index].dic) {
        this.dictionary(dictionaries[index].dic);
      }
    }
  }
}

var proto = NSpell.prototype;

// ---------------------------------------------------------------- correct
// 上游 lib/correct.js —— 这是产品里唯一的热路径,实测 1000 次 < 1ms。
proto.correct = function correct(value) {
  return Boolean(form(this, value));
};

// ---------------------------------------------------------------- suggest
// 上游 lib/suggest.js(单独一个文件,见 ./suggest.js)
proto.suggest = suggest;

// ---------------------------------------------------------------- spell
// 上游 lib/spell.js —— 比 correct() 多返回 forbidden / warn 两个标记。
// 产品目前不用它,保留是为了与上游 API 一致(将来做 personal dictionary 会用到)。
proto.spell = function spell(word) {
  var self = this;
  var value = form(self, word, true);

  // Hunspell also provides `root` (root word of the input word), and `compound`
  // (whether `word` was compound).
  return {
    correct: self.correct(word),
    forbidden: Boolean(
      value && flag(self.flags, 'FORBIDDENWORD', self.data[value])
    ),
    warn: Boolean(value && flag(self.flags, 'WARN', self.data[value]))
  };
};

// ---------------------------------------------------------------- add
// 上游 lib/add.js
proto.add = function add(value, model) {
  var self = this;

  pushWord(self.data, value, self.data[model] || NO_CODES, self);

  return self;
};

// ---------------------------------------------------------------- remove
// 上游 lib/remove.js
proto.remove = function remove(value) {
  var self = this;

  delete self.data[value];

  return self;
};

// ---------------------------------------------------------------- wordCharacters
// 上游 lib/word-characters.js
proto.wordCharacters = function wordCharacters() {
  return this.flags.WORDCHARS || null;
};

// ---------------------------------------------------------------- dictionary
// 上游 lib/dictionary.js —— ⏱️ 这个方法就是那 61ms 的入口。
proto.dictionary = function addDictionary(buf) {
  var self = this;
  var index = -1;
  var rule;
  var source;
  var character;
  var offset;

  parseDictionary(buf, self, self.data);

  // Regenerate compound expressions.
  while (++index < self.compoundRules.length) {
    rule = self.compoundRules[index];
    source = '';
    offset = -1;

    while (++offset < rule.length) {
      character = rule.charAt(offset);
      source += self.compoundRuleCodes[character].length
        ? '(?:' + self.compoundRuleCodes[character].join('|') + ')'
        : character;
    }

    self.compoundRules[index] = new RegExp(source, 'i');
  }

  return self;
};

// ---------------------------------------------------------------- personal
// 上游 lib/personal.js —— 自定义词表。
// v1.0 不暴露给用户(见 TODO.md「已考虑并推迟」一节:要存自定义词表就要 storage 权限,
// 而「只有两个权限」本身是文案卖点)。代码留着,因为它是上游 API 的一部分。
proto.personal = function personal(buf) {
  var self = this;
  var lines = String(buf).split('\n');
  var index = -1;
  var line;
  var forbidden;
  var word;
  var flagValue;

  // Ensure there’s a key for `FORBIDDENWORD`: `false` cannot be set through an
  // affix file so its safe to use as a magic constant.
  if (self.flags.FORBIDDENWORD === undefined) self.flags.FORBIDDENWORD = false;
  flagValue = self.flags.FORBIDDENWORD;

  while (++index < lines.length) {
    line = lines[index].trim();

    if (!line) {
      continue;
    }

    line = line.split('/');
    word = line[0];
    forbidden = word.charAt(0) === '*';

    if (forbidden) {
      word = word.slice(1);
    }

    self.add(word, line[1]);

    if (forbidden) {
      self.data[word].push(flagValue);
    }
  }

  return self;
};
