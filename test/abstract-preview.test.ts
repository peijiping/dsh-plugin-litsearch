import test from 'node:test'
import assert from 'node:assert/strict'

import { abstractPreview } from '../src/client/text.ts'

const LIMIT = 260

test('原文态：超长原文折叠到 limit 字并带省略号', () => {
  const source = 'a'.repeat(800)
  const result = abstractPreview({ shown: source, source, previewChars: LIMIT, expanded: false })
  assert.equal(result.collapsible, true)
  assert.equal(result.text, `${'a'.repeat(LIMIT)}…`)
})

test('原文态：展开后显示全文', () => {
  const source = 'a'.repeat(800)
  const result = abstractPreview({ shown: source, source, previewChars: LIMIT, expanded: true })
  assert.equal(result.collapsible, true)
  assert.equal(result.text, source)
})

test('原文不长时无需折叠，原文/译文都全文显示', () => {
  const source = 'a'.repeat(100)
  assert.deepEqual(
    abstractPreview({ shown: source, source, previewChars: LIMIT, expanded: false }),
    { text: source, collapsible: false },
  )
})

test('译后译文远短于原文：仍可折叠，展开能看到完整译文（核心回归）', () => {
  const source = 'a'.repeat(800) // 落盘后的英文摘要
  const translated = '这是一个被完整翻译的中文摘要'.repeat(8) // 约 120 字，远小于 260
  assert.ok(translated.length < LIMIT)

  const collapsed = abstractPreview({
    shown: translated,
    source,
    previewChars: LIMIT,
    expanded: false,
  })
  // 折叠按钮必须保留，否则用户以为只翻了一截、无法展开。
  assert.equal(collapsed.collapsible, true)
  // 预览按 译文/原文 比例缩放，明显短于译文全文。
  assert.ok(collapsed.text.endsWith('…'))
  assert.ok(collapsed.text.length < translated.length)

  const expanded = abstractPreview({
    shown: translated,
    source,
    previewChars: LIMIT,
    expanded: true,
  })
  // 展开后是完整译文，且末尾没有误导性的截断省略号。
  assert.equal(expanded.text, translated)
  assert.ok(!expanded.text.endsWith('…'))
})

test('译文较长时按同一比例截断（预览恒占全文约 limit/source）', () => {
  const source = 'a'.repeat(800)
  const translated = '译'.repeat(400)
  const result = abstractPreview({
    shown: translated,
    source,
    previewChars: LIMIT,
    expanded: false,
  })
  // 预览长度 = round(260 * 400 / 800) = 130，与原文态同为 32.5% 的预览比例。
  assert.equal(result.text, `${'译'.repeat(130)}…`)
  assert.equal(result.collapsible, true)
})
