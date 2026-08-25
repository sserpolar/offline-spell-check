/*
 * pipeline.mjs — 【已降级为 shim】真源搬走了
 *
 * ⚠️⚠️ 2026-08-15 变更:过滤逻辑的**单一真源已移到**
 *        ../shared/pipeline.js
 *
 * 为什么搬:
 *   扩展的 content script 由 chrome.scripting.executeScript 注入,只能是
 *   **classic script**(MV3 的 executeScript 不吃 ES module)。
 *   如果真源留在这里(.mjs),产品就必须复制一份过去 —— 那就是两份拷贝,
 *   迟早悄悄漂移:改了产品忘了改测试,或者反过来,而两边都不报错。
 *
 * 怎么解决的:
 *   把真源写成双消费格式(IIFE 挂 globalThis.SpellPipeline)。
 *   · 产品:当 classic script 注入,直接读 globalThis.SpellPipeline
 *   · 这里:import 取副作用,再拆成命名导出
 *   ⇒ **产品跑的字节和 probe 量的字节是同一份。**
 *      实测数字(误报 0.05% / 非词召回 18/18)可以直接搬到产品上。
 *
 * 本文件不含任何逻辑。要改规则、加技术术语、调跳过条件 —— 全去改那个文件。
 * 改完**必须**重跑 `node fp_probe.mjs` 和 `node recall_probe.mjs` 复量。
 *
 * 搬走前的原文留在 `pipeline.mjs.pre-product`(仅供 diff 对账,不再被任何代码引用)。
 */

// 取副作用:执行后 globalThis.SpellPipeline 就位。
// (Node 里这个 .js 走 CJS 加载,IIFE 照样执行;浏览器里它是 classic script。两边都行。)
import '../shared/pipeline.js';

const P = globalThis.SpellPipeline;

if (!P) {
  throw new Error(
    'SpellPipeline is not set - check that ../shared/pipeline.js exists'
  );
}

// ---- 原有 probe 用到的四个名字(fp_probe / recall_probe / context_probe)
export const visibleText   = P.visibleText;
export const attributeText = P.attributeText;
export const checkText     = P.checkText;
export const pageLang      = P.pageLang;
export const isEnglish     = P.isEnglish;

// ---- 其余也一并透出,方便将来写新 probe 时直接用产品逻辑
export const SKIP_TAGS      = P.SKIP_TAGS;
export const TECH           = P.TECH;
export const normalize      = P.normalize;
export const normalizeSpan  = P.normalizeSpan;
export const shouldSkip     = P.shouldSkip;
export const nonProseRanges = P.nonProseRanges;
export const stripNonProse  = P.stripNonProse;
export const collectTokens  = P.collectTokens;
export const ATTRS          = P.ATTRS;

export default P;
