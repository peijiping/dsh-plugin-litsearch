/**
 * 批量操作条里的按钮：图标 + 文案的胶囊按钮，以及「批量下载 ▾」下拉组合。
 *
 * 结果页与全文台账共用，保证同一组批量操作在两处的样式与交互一致。
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { DownloadIcon } from './icons'
import type { Translate } from './locales'

/** 批量条里的图标按钮：与下拉框同处一行，悬停时加深底色。 */
export function BulkActionButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactElement
  label: string
  onClick(): void
  disabled?: boolean
}): ReactElement {
  const [hover, setHover] = useState(false)
  const highlighted = hover && !disabled
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...BULK_BUTTON_STYLE,
        ...(highlighted
          ? { borderColor: 'var(--ls-accent-line-strong)', background: 'var(--ls-accent-soft-2)' }
          : null),
        ...(disabled ? { opacity: 0.45, cursor: 'default' } : null),
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

/**
 * 批量下载按钮 + 下三角：点主体打开下载进度弹窗；点箭头展开菜单，
 * 在系统文件管理器中打开下载目录（与条目上「查看已下载 ▾」的菜单一致）。
 */
export function BulkDownloadButton({
  t,
  label,
  onClick,
  disabled,
  downloadDir,
  onReveal,
}: {
  t: Translate
  label: string
  onClick(): void
  disabled: boolean
  /** 下载目录；没有目录或没有打开能力时不画下三角。 */
  downloadDir?: string
  onReveal?: (path: string) => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const groupRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutside = (event: MouseEvent): void => {
      if (groupRef.current !== null && !groupRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const revealable = downloadDir !== undefined && onReveal !== undefined

  return (
    <span ref={groupRef} style={BULK_DOWNLOAD_GROUP_STYLE}>
      <BulkActionButton
        icon={<DownloadIcon />}
        label={label}
        onClick={onClick}
        disabled={disabled}
      />
      {revealable && (
        <button
          type="button"
          style={{
            ...BULK_ARROW_STYLE,
            ...(disabled ? { opacity: 0.45, cursor: 'default' } : null),
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('bulk.revealDir')}
          title={t('bulk.revealDir')}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          ▾
        </button>
      )}
      {open && revealable && (
        <span role="menu" style={BULK_MENU_STYLE}>
          <button
            type="button"
            role="menuitem"
            style={BULK_MENU_ITEM_STYLE}
            onClick={() => {
              setOpen(false)
              if (downloadDir !== undefined) onReveal?.(downloadDir)
            }}
          >
            {t('bulk.revealDir')}
          </button>
        </span>
      )}
    </span>
  )
}

const BULK_BUTTON_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 5,
  border: '1px solid var(--ls-accent-line-strong)',
  background: 'transparent',
  color: 'var(--ls-accent-ink)',
  fontSize: 11.5,
  lineHeight: 1.4,
  cursor: 'pointer',
}

/** 批量下载 + 下三角的组合：箭头紧贴按钮右侧，菜单相对整体定位。 */
const BULK_DOWNLOAD_GROUP_STYLE: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
}
const BULK_ARROW_STYLE: CSSProperties = {
  padding: '2px 3px',
  borderRadius: 5,
  border: '1px solid var(--ls-accent-line-strong)',
  background: 'transparent',
  color: 'var(--ls-accent-ink)',
  fontSize: 12,
  lineHeight: 1.4,
  cursor: 'pointer',
}
const BULK_MENU_STYLE: CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 3,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 132,
  padding: 2,
  borderRadius: 10,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  boxShadow: 'var(--ls-shadow-2)',
}
const BULK_MENU_ITEM_STYLE: CSSProperties = {
  padding: '5px 8px',
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--ls-ink-1)',
  fontSize: 12,
  lineHeight: 1.4,
  textAlign: 'left',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
}
