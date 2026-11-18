/**
 * 右栏视觉令牌与运行期样式层。
 *
 * 宿主只加载 `client/client.js` 一个文件，没有 CSS 构建管线，所以样式只能以
 * 字符串形式随模块走、在 apply 期注入 <style>。这一层负责三件事：
 *
 * 1. `--ls-*` 令牌：浅色 / 深色（`[data-ds-dark-theme]`）两套，其他文件一律引用它；
 * 2. `.ls-*` 工具类：卡片、分段标签条、胶囊、按钮、输入、图标按钮等，只在 `.ls-root` 下生效；
 * 3. `installTheme()`：幂等注入并返回清理函数。
 *
 * 注意：本文件是 `as const` 字符串拼装，不要在这里写 JSX 或访问 window。
 */

/** 常用令牌的 TS 侧引用，避免各处手写 `var(--ls-*)` 拼错。 */
export const LS = {
  accent: 'var(--ls-accent)',
  accent2: 'var(--ls-accent-2)',
  accentInk: 'var(--ls-accent-ink)',
  accentSoft: 'var(--ls-accent-soft)',
  accentSoft2: 'var(--ls-accent-soft-2)',
  accentLine: 'var(--ls-accent-line)',
  accentLineStrong: 'var(--ls-accent-line-strong)',
  ink1: 'var(--ls-ink-1)',
  ink2: 'var(--ls-ink-2)',
  ink3: 'var(--ls-ink-3)',
  surface: 'var(--ls-surface)',
  surface2: 'var(--ls-surface-2)',
  line: 'var(--ls-line)',
  lineStrong: 'var(--ls-line-strong)',
  success: 'var(--ls-success)',
  warn: 'var(--ls-warn)',
  error: 'var(--ls-error)',
  info: 'var(--ls-info)',
  shadow2: 'var(--ls-shadow-2)',
} as const

/** 插件样式表的 `<style>` 节点标记，卸载时按它清理。 */
const STYLE_MARK = 'dsh-plugin-litsearch'

export const THEME_CSS = `
:root {
  --ls-canvas: #f4f6f9;
  --ls-surface: #ffffff;
  --ls-surface-2: #f1f3f7;
  --ls-ink-1: #101828;
  --ls-ink-2: #5a6478;
  --ls-ink-3: #8b95a7;
  --ls-placeholder: #b4bbc8;
  --ls-line: #e4e8f0;
  --ls-line-strong: #d5dae3;
  --ls-accent: #5b5bf5;
  --ls-accent-2: #4f7cf7;
  --ls-accent-ink: #4a4ae8;
  --ls-accent-soft: #eeeefe;
  --ls-accent-soft-2: #e3e3fd;
  --ls-accent-line: #c7c7fb;
  --ls-accent-line-strong: #a5a5f8;
  --ls-success: #12805c;
  --ls-success-soft: #e7f6f0;
  --ls-warn: #b26a00;
  --ls-warn-soft: #fff4e0;
  --ls-error: #c0392b;
  --ls-error-soft: #fdecec;
  --ls-info: #0e7c86;
  --ls-info-soft: #e2f4f5;
  --ls-shadow-1: 0 1px 2px rgba(16, 24, 40, 0.04);
  --ls-shadow-2: 0 1px 2px rgba(16, 24, 40, 0.04), 0 10px 24px -18px rgba(16, 24, 40, 0.22);
  --ls-line-inverse: rgba(255, 255, 255, 0.16);
  --ls-font: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
  --ls-r-6: 6px;
  --ls-r-8: 8px;
  --ls-r-12: 12px;
  --ls-r-16: 16px;
  --ls-chart-1: #5b5bf5;
  --ls-chart-2: #0e7c86;
  --ls-chart-3: #8a63e8;
  --ls-chart-4: #d9862e;
  --ls-chart-5: #2f9e68;
  --ls-chart-6: #d2588a;
  --ls-chart-7: #8793a8;
}

[data-ds-dark-theme] {
  --ls-canvas: #0e1014;
  --ls-surface: #16191f;
  --ls-surface-2: #1c2029;
  --ls-ink-1: #edeff5;
  --ls-ink-2: #a6aec0;
  --ls-ink-3: #7b8496;
  --ls-placeholder: #5c6474;
  --ls-line: rgba(255, 255, 255, 0.08);
  --ls-line-strong: rgba(255, 255, 255, 0.16);
  --ls-accent: #7c7cff;
  --ls-accent-2: #6fa0ff;
  --ls-accent-ink: #a5a5ff;
  --ls-accent-soft: rgba(124, 124, 255, 0.16);
  --ls-accent-soft-2: rgba(124, 124, 255, 0.26);
  --ls-accent-line: rgba(124, 124, 255, 0.38);
  --ls-accent-line-strong: rgba(124, 124, 255, 0.62);
  --ls-success: #4fd1a5;
  --ls-success-soft: rgba(79, 209, 165, 0.14);
  --ls-warn: #f0b357;
  --ls-warn-soft: rgba(240, 179, 87, 0.14);
  --ls-error: #f2777a;
  --ls-error-soft: rgba(242, 119, 122, 0.14);
  --ls-info: #4fb3b8;
  --ls-info-soft: rgba(79, 179, 184, 0.14);
  --ls-shadow-1: none;
  --ls-shadow-2: none;
  --ls-line-inverse: rgba(0, 0, 0, 0.3);
  --ls-chart-1: #8a8aff;
  --ls-chart-2: #4fb3b8;
  --ls-chart-3: #a98bf0;
  --ls-chart-4: #e3a45c;
  --ls-chart-5: #56c48c;
  --ls-chart-6: #e4809f;
  --ls-chart-7: #9aa6bd;
}

/* ---- 作用域与宿主兜底 -------------------------------------------------- */

.ls-root {
  font-family: var(--ls-font);
  color: var(--ls-ink-1);
}

.ls-root button,
.ls-root [role='button'],
.ls-root a {
  font-family: inherit;
  text-decoration: none;
}

/* 宿主会给 button / tab 加下划线与深色描边，这里统一压掉。 */
.ls-root button {
  border: none;
  box-shadow: none;
}

.ls-root input,
.ls-root textarea,
.ls-root select {
  font-family: inherit;
}

.ls-root ::placeholder {
  color: var(--ls-placeholder);
  opacity: 1;
}

/* ---- 文字层级 ---------------------------------------------------------- */

.ls-eyebrow {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  color: var(--ls-accent-ink);
}

.ls-page-title {
  font-size: 17px;
  font-weight: 500;
  line-height: 1.35;
  letter-spacing: -0.01em;
  color: var(--ls-ink-1);
}

.ls-section-title {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ls-ink-1);
}

.ls-card-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ls-ink-1);
}

.ls-body {
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ls-ink-2);
}

.ls-sub {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ls-ink-3);
}

.ls-micro {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ls-ink-3);
}

.ls-num {
  font-variant-numeric: tabular-nums;
}

/* ---- 卡片 -------------------------------------------------------------- */

.ls-card {
  background: var(--ls-surface);
  border: 1px solid var(--ls-line);
  border-radius: var(--ls-r-12);
  padding: 11px 12px;
}

.ls-card-quiet {
  background: var(--ls-surface-2);
  border: 1px solid transparent;
  border-radius: var(--ls-r-12);
  padding: 10px 12px;
}

.ls-card-hover {
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ls-card-hover:hover {
  border-color: var(--ls-line-strong);
  box-shadow: var(--ls-shadow-1);
}

.ls-empty {
  border: 1px dashed var(--ls-line-strong);
  border-radius: var(--ls-r-12);
  padding: 18px 14px;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ls-ink-3);
}

/* ---- 分段标签条 -------------------------------------------------------- */

.ls-seg {
  display: flex;
  flex-wrap: nowrap;
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: var(--ls-surface-2);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ls-seg::-webkit-scrollbar {
  display: none;
}

.ls-seg-item {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 5px 9px;
  border-radius: 9px;
  border: 1px solid var(--ls-line);
  background: var(--ls-surface);
  color: var(--ls-ink-2);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
}

.ls-seg-item:hover {
  color: var(--ls-ink-1);
  border-color: var(--ls-line-strong);
}

.ls-seg-item[aria-current='page'] {
  background: #111318;
  border-color: #111318;
  color: #ffffff;
}

.ls-seg-item:focus-visible {
  outline: 2px solid var(--ls-accent-line);
  outline-offset: 1px;
}

/* 激活项在 JSX 里带内联色，深色主题必须用 !important 才盖得住。 */
[data-ds-dark-theme] .ls-root .ls-seg-item[aria-current='page'] {
  background: var(--ls-accent-soft) !important;
  border-color: var(--ls-accent-line) !important;
  color: var(--ls-accent-ink) !important;
}

/* ---- 胶囊 / 徽章 ------------------------------------------------------- */

.ls-root .ls-pill-source {
  border-radius: 999px;
  border: 1px solid var(--ls-line);
  background: var(--ls-surface);
  color: var(--ls-ink-2);
  font-size: 11px;
  line-height: 1.4;
  padding: 3px 9px;
}

.ls-root .ls-pill-source[aria-pressed='true'] {
  background: var(--ls-accent-soft) !important;
  border-color: var(--ls-accent-line) !important;
  color: var(--ls-accent-ink) !important;
  font-weight: 500;
}

.ls-count-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 1px 7px;
  font-size: 10.5px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  background: var(--ls-accent-soft);
  color: var(--ls-accent-ink);
}

.ls-count-pill[data-zero='true'] {
  background: var(--ls-surface-2);
  color: var(--ls-ink-3);
}

/* ---- 按钮 -------------------------------------------------------------- */

.ls-root .ls-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.4;
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.ls-root .ls-btn.ls-btn-primary {
  background: linear-gradient(135deg, #5b5bf5, #4f7cf7);
  border: 1px solid transparent;
  color: #ffffff;
  box-shadow: 0 1px 2px rgba(63, 63, 220, 0.28);
}

.ls-root .ls-btn.ls-btn-primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.ls-root .ls-btn.ls-btn-primary:disabled {
  filter: saturate(0.4);
  opacity: 0.55;
  cursor: default;
}

.ls-root .ls-btn.ls-btn-ghost {
  background: var(--ls-surface);
  border: 1px solid var(--ls-line);
  color: var(--ls-ink-2);
}

.ls-root .ls-btn.ls-btn-ghost:hover:not(:disabled) {
  border-color: var(--ls-line-strong);
  color: var(--ls-ink-1);
}

/** 头部等紧凑区域用的胶囊。 */
.ls-root .ls-btn.ls-btn-compact {
  padding: 4px 10px;
  font-size: 11.5px;
}

.ls-root .ls-btn.ls-btn-text {
  background: transparent;
  border: none;
  color: var(--ls-accent-ink);
  padding: 2px 0;
  font-size: 12px;
}

.ls-root .ls-btn.ls-btn-text:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ls-root .ls-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: var(--ls-r-6);
  background: var(--ls-surface-2);
  color: var(--ls-ink-2);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.ls-root .ls-icon-btn:hover:not(:disabled) {
  background: var(--ls-ink-1);
  color: var(--ls-surface);
}

.ls-root .ls-icon-btn[data-active='true'] {
  background: var(--ls-accent-soft);
  color: var(--ls-accent-ink);
}

.ls-root .ls-icon-btn[data-quiet='true'] {
  background: transparent;
}

.ls-root .ls-icon-btn[data-quiet='true']:hover:not(:disabled) {
  background: var(--ls-surface-2);
  color: var(--ls-ink-1);
}

.ls-root .ls-icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
  background: var(--ls-surface-2);
  color: var(--ls-ink-3);
}

.ls-root .ls-icon-btn:focus-visible {
  outline: 2px solid var(--ls-accent-line);
  outline-offset: 1px;
}

/* ---- 输入 -------------------------------------------------------------- */

.ls-root .ls-input {
  width: 100%;
  box-sizing: border-box;
  font-size: 12px;
  line-height: 1.5;
  padding: 6px 9px;
  border-radius: var(--ls-r-8);
  border: 1px solid transparent;
  background: var(--ls-surface-2);
  color: var(--ls-ink-1);
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.ls-root .ls-input:focus {
  outline: none;
  background: var(--ls-surface);
  border-color: var(--ls-accent);
  box-shadow: 0 0 0 3px var(--ls-accent-soft);
}

.ls-root .ls-input:disabled {
  opacity: 0.5;
}

.ls-root .ls-inline-input {
  width: 100%;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  padding: 2px 0;
  border: none;
  border-bottom: 1px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--ls-ink-1);
}

.ls-root .ls-inline-input:hover {
  border-bottom-color: var(--ls-line);
}

.ls-root .ls-inline-input:focus {
  outline: none;
  border-bottom-color: var(--ls-accent);
}

.ls-root .ls-inline-sub {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--ls-ink-3);
}

.ls-root .ls-inline-sub:focus {
  color: var(--ls-ink-1);
}

/* ---- 状态与浮层 -------------------------------------------------------- */

.ls-root .ls-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--ls-success);
}

.ls-root .ls-status-dot[data-tone='saving'] {
  background: var(--ls-warn);
}

.ls-root .ls-status-dot[data-tone='error'] {
  background: var(--ls-error);
}

.ls-root .ls-menu {
  background: var(--ls-surface);
  border: 1px solid var(--ls-line);
  border-radius: 10px;
  box-shadow: var(--ls-shadow-2);
  color: var(--ls-ink-1);
}

.ls-root .ls-menu-item {
  color: var(--ls-ink-1);
}

.ls-root .ls-menu-item:hover {
  background: var(--ls-surface-2);
}

@media (prefers-reduced-motion: reduce) {
  .ls-root * {
    transition: none !important;
  }
}
`

/**
 * 注入令牌与工具类样式表。返回清理函数，交给 `ctx.effect` 管理生命周期。
 * 重复调用（HMR / 多次 apply）会先移除旧节点，避免样式叠加。
 */
export function installTheme(): () => void {
  if (typeof document === 'undefined') return () => undefined
  for (const node of document.querySelectorAll(
    `style[data-plugin="${STYLE_MARK}"][data-plugin-css]`,
  )) {
    node.remove()
  }
  const style = document.createElement('style')
  style.dataset.plugin = STYLE_MARK
  style.dataset.pluginCss = ''
  style.textContent = THEME_CSS
  document.head.appendChild(style)
  return () => {
    style.remove()
  }
}
