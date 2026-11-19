/**
 * 「设置」对话框左侧导航项专用的放大镜图标。
 *
 * 与 Zotero 插件的 SettingsNavIcon 同一套席位约定：外壳按 section id 从
 * `settings.section.icon` 取值，传入 16 大小的 React 组件，颜色由外层
 * navCell 的 currentColor 跟随，不需要为选中态另画一份。
 *
 * 16px 下不放文献页与高亮线：那不是能认出来的尺度。只保留放大镜这个
 * 唯一的识别符号，线宽和旁边的原生图标保持同一档。
 */

import type { ReactElement } from 'react'

export interface SettingsNavIconProps {
  /** 正方形边长，设置导航固定传 16。 */
  size?: number
  /** 该分区当前是否选中；颜色由 currentColor 跟随外壳，图形不随状态变化。 */
  active?: boolean
}

export function SettingsNavIcon({ size = 16 }: SettingsNavIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <circle cx="6.9" cy="6.9" r="4.15" />
      <path d="M10 10l3.4 3.4" />
    </svg>
  )
}
