/**
 * 右侧栏「开始」页 guide 卡片专用的插件图标。
 *
 * 宿主 `ui-sidebar-right` 的 EntryBox 用 `entry.icon ?? CubeGlyph` 渲染卡片
 * 图标，没传 icon 的插件一律显示灰色立方体占位；它**不读** `package.json`
 * 的 `icon`。而 guide[].icon 要的是能接 `{size, className}` 的 React 组件，
 * 不是图片 URL，客户端 bundle 又不能 import `.svg` 文件，所以这里用内联 SVG
 * 重写一份。
 *
 * 根 `icon.svg` 是 64×64 的完整版；guide 卡片只有 22 / 26px，等比缩会把
 * 2.2px 的文字线压成半像素条纹。这里用 32×32 紧凑版重排：保留「青绿圆角底
 * + 白色论文页 + 琥珀标题条 + 灰色文字行 + 深青放大镜与镜内高亮」的全部
 * 识别元素，只把笔画加粗、元素间距压紧。
 */

import { useId, type ReactElement } from 'react'

/** 宿主在有 description 时传 26，否则 22。 */
export interface GuideIconProps {
  size?: number
  className?: string
}

export function GuideIcon({ size = 26, className }: GuideIconProps): ReactElement {
  // 同一页面上可能挂多个实例，渐变 id 必须唯一；useId 带冒号，url(#...) 里去掉。
  const uid = useId().replace(/:/g, '')

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2cc8b2" />
          <stop offset="1" stopColor="#0c8f80" />
        </linearGradient>
      </defs>

      {/* 青绿圆角底：与根 icon.svg 同一组色值，自带底色，深浅主题都清晰。 */}
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${uid}-bg)`} />

      {/* 白页用纯白：26px 下比渐变更干净，和青绿底的对比也更足。 */}
      <rect x="6" y="4.5" width="14" height="23" rx="2.6" fill="#ffffff" />

      {/* 琥珀标题条与灰色文字行，和根图标同一套内容语言。 */}
      <rect x="9" y="8" width="6.5" height="1.9" rx="0.95" fill="#f2a93b" />
      <g fill="#a3c4be">
        <rect x="9" y="12.2" width="8.2" height="1.4" rx="0.7" />
        <rect x="9" y="15.1" width="6.2" height="1.4" rx="0.7" />
        <rect x="9" y="21.8" width="5.4" height="1.4" rx="0.7" />
        <rect x="9" y="24.6" width="3.4" height="1.4" rx="0.7" />
      </g>

      {/* 深青放大镜：镜内放大的文字里用琥珀条点出「命中」。 */}
      <line
        x1="24.6"
        y1="22.7"
        x2="27.8"
        y2="25.9"
        stroke="#0a6458"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="21" cy="19" r="5.3" fill="#f4fbf9" />
      <circle cx="21" cy="19" r="5.3" fill="none" stroke="#0a6458" strokeWidth="2" />
      <rect x="18.4" y="17" width="5.2" height="1.5" rx="0.75" fill="#0a6458" />
      <rect x="18.4" y="19.8" width="3.2" height="1.5" rx="0.75" fill="#f2a93b" />
    </svg>
  )
}
