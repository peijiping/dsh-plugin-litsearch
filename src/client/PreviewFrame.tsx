/**
 * 内联 HTML 全文预览框。
 *
 * 打开后先在框内显示旋转图标与醒目的加载文案，内容就绪后再显示 iframe。
 */

import { useState, type CSSProperties, type ReactElement } from 'react'

import { ACCENT } from './styles'
import type { Translate } from './locales'

interface Props {
  t: Translate
  src: string
  /** iframe 区域高度（结果卡片较矮，独立论文页更高）。 */
  height: number
  onClose(): void
}

export function PreviewFrame({ t, src, height, onClose }: Props): ReactElement {
  const [loadedSrc, setLoadedSrc] = useState('')
  const loaded = loadedSrc === src
  const title = t('pdf.fulltext')

  return (
    <div style={WRAP_STYLE}>
      <div style={HEAD_STYLE}>
        <span>{title}</span>
        <button type="button" style={CLOSE_STYLE} onClick={onClose}>
          {t('pdf.closePreview')}
        </button>
      </div>
      <div style={{ ...BODY_STYLE, height }}>
        <iframe
          key={src}
          title={title}
          src={src}
          onLoad={() => setLoadedSrc(src)}
          style={{ ...IFRAME_STYLE, opacity: loaded ? 1 : 0 }}
        />
        {!loaded && (
          <div style={OVERLAY_STYLE}>
            <Spinner />
            <span style={LOADING_TEXT_STYLE}>{t('pdf.htmlLoading')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 不依赖 CSS keyframes 的旋转图标（SMIL），避免注入 <style> 受 CSP 影响。 */
function Spinner(): ReactElement {
  return (
    <svg width={30} height={30} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(80,140,255,0.22)" strokeWidth="3" />
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke={ACCENT}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="56"
        strokeDashoffset="42"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  )
}

const WRAP_STYLE: CSSProperties = {
  marginTop: 6,
  border: '1px solid rgba(127,127,127,0.22)',
  borderRadius: 6,
  overflow: 'hidden',
}
const HEAD_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '3px 8px',
  fontSize: 11,
  background: 'rgba(127,127,127,0.08)',
}
const CLOSE_STYLE: CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: ACCENT,
  fontSize: 12.5,
  cursor: 'pointer',
}
const BODY_STYLE: CSSProperties = {
  position: 'relative',
  background: '#fff',
  overflow: 'hidden',
}
const IFRAME_STYLE: CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
  border: 'none',
  background: '#fff',
  transition: 'opacity 0.15s ease',
}
const OVERLAY_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  background: '#fff',
}
const LOADING_TEXT_STYLE: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: ACCENT,
}
