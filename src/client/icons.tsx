/**
 * 面板右上角的内联图标与图标按钮。
 *
 * 项目不依赖图标库，SVG 一律用 `currentColor` 描边，深浅主题都能读清。
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'

interface IconButtonProps {
  label: string
  onClick: () => void
  children: ReactNode
  /** 边长，默认 26（面板头部）；分组行传 20。 */
  size?: number
  /** 安静模式：默认透明底，hover 才出现底纹。 */
  quiet?: boolean
  /** 处于生效状态（例如该分组正在被筛选）。 */
  active?: boolean
  disabled?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * 图标按钮：外观交给 `.ls-icon-btn`，这里只管尺寸与可达性。
 * 不再用 hover state —— CSS 的 :hover 更省事，也不会在触摸设备上卡住。
 */
export function IconButton({
  label,
  onClick,
  children,
  size = 26,
  quiet = false,
  active = false,
  disabled = false,
  className,
  style,
}: IconButtonProps): ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`ls-icon-btn${className === undefined ? '' : ` ${className}`}`}
      {...(quiet ? { 'data-quiet': 'true' } : {})}
      {...(active ? { 'aria-pressed': 'true', 'data-active': 'true' } : {})}
      style={{ width: size, height: size, flexShrink: 0, ...style }}
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

/** 检索轮次：循环箭头。 */
export function RoundIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.7-6.2" />
      <path d="M20.5 4v5h-5" />
    </svg>
  )
}

/** 检索进行中：旋转的缺口圆环（SMIL 动画，无需注入 keyframes）。 */
export function SpinnerIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <circle cx="12" cy="12" r="8.5" opacity="0.3" />
      <path d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5" strokeWidth={2.6}>
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

/** 本轮结果：清单行。 */
export function ResultIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M8 6h12M8 12h12M8 18h8" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={2.4} />
    </svg>
  )
}

/** 提醒 / 告警：三角感叹号。 */
export function AlertIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M12 3.5 2.8 19.5a1.2 1.2 0 0 0 1 1.8h16.4a1.2 1.2 0 0 0 1-1.8z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.5h.01" strokeWidth={2.4} />
    </svg>
  )
}

/** 筛选：漏斗。 */
export function FilterIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M3.5 5h17l-6.5 7.5V19l-4 2v-8.5z" />
    </svg>
  )
}

/** 下拉展开：16px 粗描边下箭头，比 ▾ 字形更醒目。 */
export function ChevronDownIcon(): ReactElement {
  return (
    <svg {...svgProps} strokeWidth={2.2}>
      <path d="m5 8.5 7 7 7-7" />
    </svg>
  )
}

/** 发起时间：时钟。 */
export function ClockIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 1.9" />
    </svg>
  )
}

/** 加入对话：带文字行的对话气泡。 */
export function ChatIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M4 5.5h16v11H9l-5 4z" />
      <path d="M8 9.5h8M8 12.5h5" />
    </svg>
  )
}

/** 下载：箭头落入托盘。 */
export function DownloadIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </svg>
  )
}

/** Zotero：书签。 */
export function ZoteroIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M6.5 4.5h11v16L12 16.5l-5.5 4z" />
    </svg>
  )
}

/** 条件分区 · 数据源：圆柱数据库。 */
export function DatabaseIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </svg>
  )
}

/** 条件分区 · 每源数量：三张叠放的卡片。 */
export function StackIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <rect x="5" y="3.5" width="13" height="9" rx="1.6" />
      <path d="M3.5 8.5v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2" />
    </svg>
  )
}

/** 条件分区 · 排序：自上而下的递减横条。 */
export function SortIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M4 6.5h13M4 12h9M4 17.5h5" />
      <path d="M17 15.5l2.5 2.5 2.5-2.5M19.5 6.5v11.5" />
    </svg>
  )
}

/** 排序 · 上移：向上箭头。 */
export function ArrowUpIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  )
}

/** 排序 · 下移：向下箭头。 */
export function ArrowDownIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </svg>
  )
}

/** 删除：垃圾桶。 */
export function TrashIcon(): ReactElement {
  return (
    <svg {...fieldSvgProps}>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V4.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v1.7" />
      <path d="M6.5 6.5 7.4 19a1.2 1.2 0 0 0 1.2 1.1h6.8a1.2 1.2 0 0 0 1.2-1.1l.9-12.5" />
      <path d="M10.5 10v6M13.5 10v6" />
    </svg>
  )
}
