/**
 * 面板顶部通知条：任务切换预检失败等跨页面提醒。
 */

import type { CSSProperties, ReactElement } from 'react'

import type { Translate } from './locales'
import { dismissNotice, useNotice } from './noticeStore'
import { ERROR, linkButtonStyle } from './styles'

export function NoticeBar({ t }: { t: Translate }): ReactElement | null {
  const notice = useNotice()
  if (notice === null) return null
  return (
    <div
      role="alert"
      style={notice.tone === 'error' ? { ...BAR_STYLE, borderLeft: `3px solid ${ERROR}` } : BAR_STYLE}
    >
      <span style={TEXT_STYLE}>{notice.text}</span>
      <button type="button" style={linkButtonStyle} onClick={() => dismissNotice()}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}

const BAR_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid var(--ls-line)',
  background: 'var(--ls-surface)',
  fontSize: 12,
  lineHeight: 1.55,
  boxShadow: 'var(--ls-shadow-2)',
}

const TEXT_STYLE: CSSProperties = {
  minWidth: 0,
  flex: '1 1 auto',
  wordBreak: 'break-word',
}
