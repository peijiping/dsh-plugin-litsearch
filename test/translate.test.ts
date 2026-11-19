import test from 'node:test'
import assert from 'node:assert/strict'

import {
  autoTarget,
  bingLanguage,
  detectSource,
  languageFamily,
  readBingTranslations,
  splitChunks,
} from '../src/search/translate-core.ts'

test('detectSource 判中英文', () => {
  assert.equal(detectSource('口腔益生菌与刷牙联合治疗口臭的随机对照试验'), 'zh')
  assert.equal(
    detectSource('Tongue brushing and oral probiotics for the treatment of halitosis'),
    'en',
  )
  // 中文摘要里夹缩写不该被判成英文。
  assert.equal(detectSource('采用 PCR 与 VSC 检测口腔挥发性硫化物，评估疗效'), 'zh')
  // 假名一出就是日文。
  assert.equal(detectSource('口腔ケアのランダム化比較試験'), 'other')
  assert.equal(detectSource(''), 'other')
})

test('autoTarget 中英互译', () => {
  assert.equal(autoTarget('这是一篇中文摘要'), 'en')
  assert.equal(autoTarget('This is an English abstract'), 'zh-CN')
  assert.equal(autoTarget('PCR'), 'zh-CN')
})

test('bingLanguage 语言码映射', () => {
  assert.equal(bingLanguage('zh-CN'), 'zh-Hans')
  assert.equal(bingLanguage('zh'), 'zh-Hans')
  assert.equal(bingLanguage('zh-TW'), 'zh-Hant')
  assert.equal(bingLanguage('zh-Hant'), 'zh-Hant')
  assert.equal(bingLanguage('en'), 'en')
  assert.equal(bingLanguage('ja'), 'ja')
})

test('languageFamily 中文简繁同族', () => {
  assert.equal(languageFamily('zh-CN'), languageFamily('zh-TW'))
  assert.equal(languageFamily('en-US'), 'en')
  assert.notEqual(languageFamily('en'), languageFamily('zh-CN'))
})

test('splitChunks 保留原文与分隔', () => {
  const short = 'a short abstract'
  assert.deepEqual(splitChunks(short, 100), [short])

  const paragraph = 'First paragraph. '.repeat(20)
  const second = 'Second paragraph! '.repeat(20)
  const text = `${paragraph}\n\n${second}`
  const chunks = splitChunks(text, 120)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 1)
  // 优先在段落边界切，因此第一块结尾应落在第一段末尾附近。
  assert.ok(chunks[0]?.endsWith('\n\n') === true || chunks[0]?.endsWith(' ') === true)

  // 无空格的超长串按硬切处理，仍不丢字符。
  const dense = '中'.repeat(300)
  const denseChunks = splitChunks(dense, 100)
  assert.equal(denseChunks.join(''), dense)
  assert.equal(denseChunks.length, 3)
})

test('readBingTranslations 解析与校验', () => {
  const payload = [
    { detectedLanguage: { language: 'en' }, translations: [{ text: '你好' }] },
    { detectedLanguage: { language: 'en' }, translations: [{ text: '世界' }] },
  ]
  assert.deepEqual(readBingTranslations(payload, 2), {
    texts: ['你好', '世界'],
    detected: 'en',
  })

  // 数量不符、缺 translations、空译文都视为无法识别。
  assert.equal(readBingTranslations(payload, 1), undefined)
  assert.equal(readBingTranslations([], 1), undefined)
  assert.equal(readBingTranslations([{ translations: [] }], 1), undefined)
  assert.equal(readBingTranslations([{ translations: [{ text: '  ' }] }], 1), undefined)
  assert.equal(readBingTranslations(null, 1), undefined)
})
