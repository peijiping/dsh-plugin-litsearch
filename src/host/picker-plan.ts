/**
 * 各平台「选择文件夹」命令的纯函数部分：只拼参数、判取消、解析输出。
 *
 * 与 picker.ts 拆开是为了让单测能直接加载（picker.ts 依赖带 `.js` 后缀的
 * 相对导入，node:test 的类型剥离不映射到 `.ts`）。
 */

export interface PickerPlan {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export const PROMPT = '选择文献 PDF 的保存目录'

/** 默认路径一律通过 argv / 环境变量传入，不拼进脚本字符串。 */
export function buildPickerPlan(
  platform: NodeJS.Platform,
  defaultPath?: string,
): PickerPlan {
  const dir = defaultPath?.trim() ?? ''
  if (platform === 'darwin') {
    const script = [
      '-e',
      'on run argv',
      '-e',
      dir === ''
        ? `set chosenFolder to choose folder with prompt "${PROMPT}"`
        : `set chosenFolder to choose folder with prompt "${PROMPT}" default location (POSIX file (item 1 of argv))`,
      '-e',
      'return POSIX path of chosenFolder',
      '-e',
      'end run',
    ]
    return {
      command: 'osascript',
      args: dir === '' ? script : [...script, dir],
    }
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog;',
      `$f.Description = "${PROMPT}";`,
      'if ($env:LITSEARCH_PICK_DIR) { $f.SelectedPath = $env:LITSEARCH_PICK_DIR };',
      'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }',
    ].join(' ')
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-STA', '-Command', script],
      env: { ...process.env, LITSEARCH_PICK_DIR: dir },
    }
  }
  return {
    command: 'zenity',
    args: [
      '--file-selection',
      '--directory',
      `--title=${PROMPT}`,
      ...(dir === '' ? [] : [`--filename=${dir}/`]),
    ],
  }
}

/** 平台的「用户取消」判定：取消不是错误，界面不弹红色提示。 */
export function isPickerCancel(
  platform: NodeJS.Platform,
  code: number | null,
  stderr: string,
): boolean {
  if (platform === 'darwin') return code !== 0 && /-128|User canceled/u.test(stderr)
  if (platform === 'linux') return code === 1 && stderr.trim() === ''
  return false
}

/** 解析对话框输出：取最后一行非空路径。 */
export function parsePickerOutput(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1)
}
