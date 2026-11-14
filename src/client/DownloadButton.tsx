/**
 * 「下载 PDF / 查看已下载」动作按钮。
 *
 * 未下载时是单个下载按钮；已下载时变为「查看已下载 ▾」拆分按钮：点文字在右侧
 * 预览本地 PDF，点箭头展开菜单，可在系统文件管理器中定位该文件。文件被删除后
 * 回到普通按钮并提示点击重新下载。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { SpinnerIcon } from './icons'
import type { Translate } from './locales'

/** 已下载状态的绿色，与徽章 / 状态色一致。 */
const DOWNLOADED_COLOR = '#2e9e5b'
/** 本地文件已被删除的警示色。 */
const MISSING_COLOR = '#d64545'

interface Props {
  t: Translate
  label: string
  hint?: string
  /** 已下载文件的绝对路径；有值时展示拆分按钮。 */
  downloadedPath?: string
  /** 已下载的文件已被删除 / 移走：显示警示色，点击走下载而不是预览。 */
  missing?: boolean
  downloading?: boolean
  disabled?: boolean
  /** 调用点的链接按钮样式（各面板字号不同）。 */
  style: CSSProperties
  onDownload(): void
  onOpen?(path: string): void
  onReveal?(path: string): void
}

export function DownloadButton({
  t,
  label,
  hint,
  downloadedPath,
  missing = false,
  downloading = false,
  disabled = false,
  style,
  onDownload,
  onOpen,
  onReveal,
}: Props): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const groupRef = useRef<HTMLSpanElement>(null)
  const path = downloadedPath ?? ''
  const downloaded = !missing && path !== '' && onOpen !== undefined
  const color = missing ? MISSING_COLOR : downloaded ? DOWNLOADED_COLOR : undefined

  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutside = (event: MouseEvent): void => {
      if (groupRef.current !== null && !groupRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  const main = (
    <button
      type="button"
      style={{
        ...style,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        ...(color === undefined ? null : { color }),
      }}
      disabled={disabled || downloading}
      title={hint}
      aria-busy={downloading}
      onClick={() => {
        if (downloaded) onOpen?.(path)
        else onDownload()
      }}
    >
      {downloading && <SpinnerIcon />}
      {label}
    </button>
  )

  if (!downloaded || onReveal === undefined) return main

  return (
    <span ref={groupRef} style={GROUP_STYLE}>
      {main}
      <button
        type="button"
        style={{ ...style, ...ARROW_STYLE, color: DOWNLOADED_COLOR }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('pdf.revealInFolder')}
        title={t('pdf.revealInFolder')}
        disabled={disabled}
        onClick={() => setMenuOpen((value) => !value)}
      >
        ▾
      </button>
      {menuOpen && (
        <span role="menu" style={MENU_STYLE}>
          <button
            type="button"
            role="menuitem"
            style={MENU_ITEM_STYLE}
            onClick={() => {
              setMenuOpen(false)
              onReveal?.(path)
            }}
          >
            {t('pdf.revealInFolder')}
          </button>
        </span>
      )}
    </span>
  )
}

const GROUP_STYLE: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
}

const ARROW_STYLE: CSSProperties = {
  padding: '0 1px',
  lineHeight: 1,
  fontSize: 20,
}

const MENU_STYLE: CSSProperties = {
  position: 'absolute',
  top: '100%',
  right: 0,
  marginTop: 3,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 132,
  padding: 2,
  borderRadius: 6,
  border: '1px solid rgba(127,127,127,0.3)',
  background: '#fff',
  boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
}

const MENU_ITEM_STYLE: CSSProperties = {
  padding: '5px 8px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: '#1f2328',
  fontSize: 12,
  lineHeight: 1.4,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}
