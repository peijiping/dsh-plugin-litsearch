import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROMPT,
  buildPickerPlan,
  isPickerCancel,
  parsePickerOutput,
} from '../src/host/picker-plan.ts'

test('macOS：默认路径通过 argv 传入，不拼进 AppleScript', () => {
  const withDefault = buildPickerPlan('darwin', '/tmp/paper dir')
  assert.equal(withDefault.command, 'osascript')
  assert.equal(withDefault.args.at(-1), '/tmp/paper dir')
  const script = withDefault.args.slice(0, -1).join('\n')
  assert.ok(script.includes('item 1 of argv'))
  assert.equal(script.includes('/tmp/paper dir'), false)

  const bare = buildPickerPlan('darwin', '  ')
  assert.equal(bare.args.at(-1), 'end run')
  assert.equal(bare.args.join('\n').includes('default location'), false)
})

test('Windows：默认路径走环境变量，不出现在命令里', () => {
  const plan = buildPickerPlan('win32', 'C:\\papers')
  assert.equal(plan.command, 'powershell.exe')
  assert.equal(plan.env?.LITSEARCH_PICK_DIR, 'C:\\papers')
  assert.equal(plan.args.join(' ').includes('C:\\papers'), false)
  assert.equal(plan.args.includes('-STA'), true)
})

test('Linux：默认路径作为 --filename 参数并以斜杠结尾', () => {
  const plan = buildPickerPlan('linux', '/tmp/papers')
  assert.equal(plan.command, 'zenity')
  assert.equal(plan.args.includes('--directory'), true)
  assert.equal(plan.args.includes(`--title=${PROMPT}`), true)
  assert.equal(plan.args.includes('--filename=/tmp/papers/'), true)
  assert.equal(buildPickerPlan('linux').args.some((arg) => arg.startsWith('--filename=')), false)
})

test('isPickerCancel 只认各平台的用户取消特征', () => {
  assert.equal(isPickerCancel('darwin', 1, 'execution error: User canceled. (-128)'), true)
  assert.equal(isPickerCancel('darwin', 1, 'some other failure'), false)
  assert.equal(isPickerCancel('darwin', 0, ''), false)
  assert.equal(isPickerCancel('linux', 1, '  \n'), true)
  assert.equal(isPickerCancel('linux', 1, 'zenity: error'), false)
  assert.equal(isPickerCancel('win32', 1, 'User canceled'), false)
})

test('parsePickerOutput 取最后一行非空输出', () => {
  assert.equal(parsePickerOutput('/Users/me/My Papers/\n'), '/Users/me/My Papers/')
  assert.equal(parsePickerOutput('noise\r\n  /tmp/a  \r\n'), '/tmp/a')
  assert.equal(parsePickerOutput('   \n'), undefined)
})
