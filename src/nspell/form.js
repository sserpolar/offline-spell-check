/*
 * nspell word-form lookup — ESM port
 *
 * ⚠️ 移植代码。上游 nspell 2.1.5 (MIT),本文件 = 以下四个上游文件逐行照搬:
 *   lib/util/normalize.js · lib/util/casing.js · lib/util/flag.js
 *   lib/util/exact.js     · lib/util/form.js
 * 改动:仅 require/module.exports → import/export。算法一字未改。
 *
 * 这里是**查词的心脏**:`form()` 决定一个词算不算拼对。
 * 误报率 0.05% / 非词错误召回 18/18 这两个实测数,最终都落在这个函数上。
 */

// ---------------------------------------------------------------- normalize
// 上游 lib/util/normalize.js
// 用 aff 里的 ICONV/OCONV 规则做字符归一(en 词典用它把智能引号 ’ 归一成 ')。
export function normalize(value, patterns) {
  var index = -1;

  while (++index < patterns.length) {
    value = value.replace(patterns[index][0], patterns[index][1]);
  }

  return value;
}

// ---------------------------------------------------------------- casing
// 上游 lib/util/casing.js
// 返回 'l'(全小写) / 'u'(全大写) / 's'(句首大写) / null(混合)。
export function casing(value) {
  var head = exactCase(value.charAt(0));
  var rest = value.slice(1);

  if (!rest) {
    return head;
  }

  rest = exactCase(rest);

  if (head === rest) {
    return head;
  }

  if (head === 'u' && rest === 'l') {
    return 's';
  }

  return null;
}

function exactCase(value) {
  return value === value.toLowerCase()
    ? 'l'
    : value === value.toUpperCase()
    ? 'u'
    : null;
}

// ---------------------------------------------------------------- flag
// 上游 lib/util/flag.js
export function flag(values, value, flags) {
  return flags && value in values && flags.indexOf(values[value]) > -1;
}

// ---------------------------------------------------------------- exact
// 上游 lib/util/exact.js
// 精确查表,外加 compound rule 兜底(en 词典用它处理 1st / 22nd / 123rd 这类序数词)。
export function exact(context, value) {
  var index = -1;

  if (context.data[value]) {
    return !flag(context.flags, 'ONLYINCOMPOUND', context.data[value]);
  }

  // Check if this might be a compound word.
  if (value.length >= context.flags.COMPOUNDMIN) {
    while (++index < context.compoundRules.length) {
      if (context.compoundRules[index].test(value)) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------- form
// 上游 lib/util/form.js
//
// ⭐ 注意这里已经内建了「全大写回退句首大写」和「回退小写」两级尝试。
//    这就是为什么 pipeline 里 `spell.correct(w) || spell.correct(w.toLowerCase())`
//    第二次调用几乎总是多余的 —— 但留着不亏,成本是 0.000ms 级。
export default function form(context, value, all) {
  var normal = value.trim();
  var alternative;

  if (!normal) {
    return null;
  }

  normal = normalize(normal, context.conversion.in);

  if (exact(context, normal)) {
    if (!all && flag(context.flags, 'FORBIDDENWORD', context.data[normal])) {
      return null;
    }

    return normal;
  }

  // Try sentence case if the value is uppercase.
  if (normal.toUpperCase() === normal) {
    alternative = normal.charAt(0) + normal.slice(1).toLowerCase();

    if (ignore(context.flags, context.data[alternative], all)) {
      return null;
    }

    if (exact(context, alternative)) {
      return alternative;
    }
  }

  // Try lowercase.
  alternative = normal.toLowerCase();

  if (alternative !== normal) {
    if (ignore(context.flags, context.data[alternative], all)) {
      return null;
    }

    if (exact(context, alternative)) {
      return alternative;
    }
  }

  return null;
}

function ignore(flags, dict, all) {
  return (
    flag(flags, 'KEEPCASE', dict) || all || flag(flags, 'FORBIDDENWORD', dict)
  );
}
