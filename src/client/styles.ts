/**
 * 右栏界面共用样式。
 */

/** 主题蓝（与 dsh 分隔条 hover 蓝一致）。 */
export const ACCENT = '#508cff'

/** 错误色。 */
export const ERROR = '#d64545'

/** 面板根容器（主页 / 任务页 / 论文页共用）：上下 10px、左右 15px 页面边距。 */
export const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
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
  fontSize: 12,
  opacity: 0.66,
  marginRight: 2,
} as const

/** 状态 / 提示文本。 */
export const statusStyle = {
  fontSize: 12,
  opacity: 0.72,
  lineHeight: 1.5,
} as const

/** 结果列表。 */
export const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
} as const

/** 单条结果卡片：顶线即文献之间的分割线，透明度需足够高才看得清。 */
export const cardStyle = {
  padding: '10px 0',
  borderTop: '1px solid rgba(127,127,127,0.5)',
} as const

/** 标题。 */
export const titleStyle = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.45,
  color: 'inherit',
  textDecoration: 'none',
} as const

/** 元信息行（作者、年份、出处）。 */
export const metaStyle = {
  marginTop: 4,
  fontSize: 12,
  opacity: 0.72,
  lineHeight: 1.5,
} as const

/** 小徽章行。 */
export const badgeRowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 6,
} as const

/** 徽章。 */
export const badgeStyle = {
  fontSize: 11,
  lineHeight: 1.4,
  padding: '1px 6px',
  borderRadius: 4,
  border: `1px solid rgba(80,140,255,0.4)`,
  color: ACCENT,
  whiteSpace: 'nowrap',
} as const

/** 摘要。 */
export const abstractStyle = {
  marginTop: 6,
  fontSize: 12,
  opacity: 0.8,
  lineHeight: 1.55,
} as const

/** 类链接按钮。 */
export const linkButtonStyle = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: ACCENT,
  fontSize: 12,
  cursor: 'pointer',
} as const

/** 普通外链。 */
export const linkStyle = {
  color: ACCENT,
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

/** Toast。 */
export const toastStyle = {
  fontSize: 12,
  color: ACCENT,
} as const
