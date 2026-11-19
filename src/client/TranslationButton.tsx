/**
 * 「原 / 译」切换按钮：卡片右上角与单篇论文页操作行共用。
 *
 * 标签写的是**点下去会发生什么**：显示原文时按钮为「译」，点一下翻译；
 * 显示译文时按钮为「原」，点一下回到原文。翻译进行中显示转圈图标。
 */

import type { CSSProperties, ReactElement } from 'react'

import { SpinnerIcon } from './icons'
import { tpl, type Translate } from './locales'
import type { TranslationState } from './useTranslation'

interface Props {
  t: Translate
  state: TranslationState
  className?: string
  style?: CSSProperties
}

export function TranslationButton({ t, state, className, style }: Props): ReactElement {
  const engine = state.provider === undefined ? '' : t(`translate.provider.${state.provider}`)
  const title = state.busy
    ? t('result.translating')
    : state.on
      ? tpl(t('result.translatedHint'), { engine })
      : t('result.translateHint')
  return (
    <button
      type="button"
      {...(className === undefined ? {} : { className })}
      {...(style === undefined ? {} : { style })}
      title={title}
      aria-label={title}
      aria-pressed={state.on}
      disabled={state.busy}
      onClick={state.toggle}
    >
      {state.busy ? <SpinnerIcon /> : state.on ? t('result.showOriginal') : t('result.translate')}
    </button>
  )
}
