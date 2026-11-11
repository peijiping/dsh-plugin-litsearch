/**
 * PDF 下载落点解析的回归测试：显式配置优先，其次会话工作目录，最后旧默认。
 *
 * 只导入纯 Node 逻辑模块，避开源码里的 `.js` 相对导入（node:test 不映射）。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { PDF_SUBDIR, expandHomePath, resolvePdfRootPath } from '../src/host/pdf/root.ts'
import { normalizeWorkspace } from '../src/host/workspace.ts'

const HOME = '/tmp/litsearch-fake-home'
const WORKSPACE = '/Users/me/project'

test('显式配置的 pdfRoot 优先于会话工作目录', () => {
  assert.equal(resolvePdfRootPath('/papers/custom', WORKSPACE, HOME), '/papers/custom')
  assert.equal(resolvePdfRootPath('  /papers/custom  ', WORKSPACE, HOME), '/papers/custom')
})

test('未配置时落在会话工作目录下的 dsh-litsearch/', () => {
  assert.equal(resolvePdfRootPath('', WORKSPACE, HOME), join(WORKSPACE, PDF_SUBDIR))
  assert.equal(resolvePdfRootPath('   ', WORKSPACE, HOME), join(WORKSPACE, PDF_SUBDIR))
})

test('既未配置也没有工作目录时保留旧默认 ~/Downloads/dsh-litsearch', () => {
  assert.equal(resolvePdfRootPath('', undefined, HOME), join(HOME, 'Downloads', PDF_SUBDIR))
})

test('配置里的 ~ / ~/... 会展开到 home', () => {
  assert.equal(expandHomePath('~', HOME), HOME)
  assert.equal(expandHomePath('~/papers', HOME), join(HOME, 'papers'))
  assert.equal(resolvePdfRootPath('~/papers', WORKSPACE, HOME), join(HOME, 'papers'))
})

test('normalizeWorkspace 只接受绝对路径并去掉尾斜杠', () => {
  assert.equal(normalizeWorkspace(`${WORKSPACE}/`), WORKSPACE)
  assert.equal(normalizeWorkspace('  /  '), '/')
  assert.equal(normalizeWorkspace('relative/dir'), undefined)
  assert.equal(normalizeWorkspace('   '), undefined)
  assert.equal(normalizeWorkspace(undefined), undefined)
})
