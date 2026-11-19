/**
 * 右栏界面共用样式。
 *
 * 令牌与工具类定义在 `theme.ts`（运行期注入）；这里只保留可直接内联到 JSX 的
 * 结构 / 排版对象。颜色一律引用 `--ls-*`，不写死色值，否则深色主题会破相。
 */

import { LS } from './theme'

/** 主色（选中、主操作、强调数字）。 */
export const ACCENT = LS.accent

/** 错误色。 */
export const ERROR = LS.error

/** 卡片类名：底色、发丝边、圆角、hover 都在 CSS 里，内联表达不了 hover。 */
export const CARD_CLASS = 'ls-card'

/** 面板根容器（主页 / 任务页 / 论文页共用）：上下 10px、左右 15px 页面边距。 */
export const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '10px 15px',
  minHeight: 0,
  fontSize: 13,
} as const

/** 搜索行：输入框 + 按钮。 */
export const formStyle = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
} as const

/** 数据源多选行。 */
export const sourceRowStyle = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
} as const

/** 数据源行前的小标签。 */
export const sourceLabelStyle = {
  fontSize: 11.5,
  color: LS.ink3,
  marginRight: 2,
} as const

/** 状态 / 提示文本。 */
export const statusStyle = {
  fontSize: 11.5,
  color: LS.ink2,
  lineHeight: 1.65,
} as const

/** 结果列表：卡片之间留出呼吸感，不再用顶部分割线。 */
export const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
} as const

/** 单条结果的卡片内边距；外观（底色 / 边框 / 圆角）由 {@link CARD_CLASS} 提供。 */
export const cardStyle = {
  padding: '11px 12px',
} as const

/** 标题。 */
export const titleStyle = {
  display: 'block',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.45,
  color: LS.ink1,
  textDecoration: 'none',
} as const

/** 元信息行（作者、年份、出处）。 */
export const metaStyle = {
  marginTop: 5,
  fontSize: 11.5,
  color: LS.ink3,
  lineHeight: 1.6,
} as const

/** 小徽章行。 */
export const badgeRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 6,
} as const

/** 徽章：中性胶囊。强调色由调用方覆写 `color`，底色保持中性以免撞色。 */
export const badgeStyle = {
  fontSize: 11,
  lineHeight: 1.5,
  padding: '2px 8px',
  borderRadius: 999,
  border: `1px solid ${LS.line}`,
  background: LS.surface2,
  color: LS.ink2,
  whiteSpace: 'nowrap',
} as const

/** 摘要。 */
export const abstractStyle = {
  marginTop: 7,
  fontSize: 12.5,
  color: LS.ink2,
  lineHeight: 1.65,
} as const

/** 类链接按钮。 */
export const linkButtonStyle = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: LS.accentInk,
  fontSize: 12,
  lineHeight: 1.4,
  textDecoration: 'none',
  boxShadow: 'none',
  cursor: 'pointer',
} as const

/** 卡片快捷操作里的主操作按钮：描边胶囊 + 图标 + 文案。 */
export const actionButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 9px',
  borderRadius: 5,
  border: `1px solid ${LS.accentLineStrong}`,
  background: 'transparent',
  color: LS.accentInk,
  fontSize: 11.5,
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
} as const

/** 普通外链。 */
export const linkStyle = {
  color: LS.accentInk,
  textDecoration: 'none',
  fontSize: 12,
} as const

/** 操作行。 */
export const actionRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginTop: 8,
} as const

/** 提醒浮层容器：贴面板底部堆叠，不遮挡操作按钮的点击。 */
export const toastStackStyle = {
  position: 'absolute',
  left: 15,
  right: 15,
  bottom: 14,
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  pointerEvents: 'none',
} as const

/** 底部自动消失的提醒：卡片浮层（跟随主题，不再用黑底）。 */
export const toastStyle = {
  padding: '8px 12px',
  borderRadius: 10,
  border: `1px solid ${LS.line}`,
  background: LS.surface,
  color: LS.ink1,
  fontSize: 12,
  lineHeight: 1.55,
  boxShadow: LS.shadow2,
  pointerEvents: 'none',
} as const

/** 下载失败等错误提醒：左侧红条区分。 */
export const toastErrorStyle = {
  borderLeft: `3px solid ${LS.error}`,
} as const
