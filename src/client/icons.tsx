/**
 * 面板右上角的内联图标与图标按钮。
 *
 * 项目不依赖图标库，SVG 一律用 `currentColor` 描边，深浅主题都能读清。
 */

import { useState, type ReactElement, type ReactNode } from 'react'

interface IconButtonProps {
  label: string
  onClick: () => void
  children: ReactNode
}

export function IconButton({ label, onClick, children }: IconButtonProps): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        borderRadius: 6,
        cursor: 'pointer',
        color: 'inherit',
        opacity: hover ? 1 : 0.74,
        border: `1px solid ${hover ? 'rgba(80,140,255,0.7)' : 'rgba(127,127,127,0.32)'}`,
        background: hover ? 'rgba(80,140,255,0.12)' : 'transparent',
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

const svgProps = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/** 历史时间轴：回拨箭头 + 表盘。 */
export function HistoryIcon(): ReactElement {
  return (
    <svg {...svgProps}>
      <path d="M3.5 9A9 9 0 1 1 3 13" />
      <path d="M3 4v5h5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

/** 搜索任务列表：三行清单。 */
export function TaskListIcon(): ReactElement {
  return (
    <svg {...svgProps}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeWidth={2.4} />
    </svg>
  )
}

/** 结果卡片字段图标统一尺寸：比右上角图标按钮略小，跟正文基线对齐。 */
const fieldSvgProps = { ...svgProps, width: 14, height: 14 } as const

/** 文献标题：带折角的文档 + 标题行。 */
export function TitleIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  )
}

/** 作者：双人像。 */
export function AuthorsIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20v-1a5.5 5.5 0 0 1 11 0v1" />
      <path d="M16 5.4a3 3 0 0 1 0 5.2M18 15.2a5 5 0 0 1 2.5 3.8v1" />
    </svg>
  )
}

/** 摘要：段落横排文字。 */
export function AbstractIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M4 6h16M4 10h16M4 14h13M4 18h8" />
    </svg>
  )
}
