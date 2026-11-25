/**
 * LINE 的 action label 上限 20 字（Rich Menu 等）。超過時整個選單建立會被 LINE 以 400 拒絕。
 * 以字元（code point）計，不把表情符號切一半。
 */
export const ACTION_LABEL_MAX = 20;

export function clampActionLabel(label) {
  if (label === undefined || label === null || label === '') return undefined;
  const chars = [...String(label)];
  return chars.length > ACTION_LABEL_MAX ? chars.slice(0, ACTION_LABEL_MAX).join('') : chars.join('');
}
