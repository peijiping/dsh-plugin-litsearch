/**
 * 原生「选择文件夹」对话框。
 *
 * DSH 的界面跑在浏览器里，拿不到绝对路径；PDF 落地由 Host 完成，因此目录
 * 选择必须在宿主机器上弹系统对话框。命令拼装见 picker-plan.ts；默认路径
 * 一律通过 argv / 环境变量传入，绝不拼进脚本字符串。取消时返回
 * `cancelled: true`，其余失败抛出可读错误。
 */

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'

import { buildPickerPlan, isPickerCancel, parsePickerOutput } from './picker-plan.js'
import type { PickerPlan } from './picker-plan.js'
import { resolveDownloadDir } from './pdf/root.js'

export interface PickerResult {
  path?: string
  cancelled: boolean
}

/** 默认路径只接受已存在的目录；不存在时不设置初始位置，避免对话框直接报错。 */
export async function existingPickerDefault(raw: string | undefined): Promise<string | undefined> {
  const value = raw?.trim() ?? ''
  if (value === '') return undefined
  const resolved = resolveDownloadDir(value)
  if (resolved === null) return undefined
  try {
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

let picking = false

/** 弹出系统目录选择框；同一时间只允许一个，避免叠出多个模态框。 */
export async function pickDirectory(rawDefault?: string): Promise<PickerResult> {
  if (picking) throw new Error('目录选择框已经打开，请先完成上一次选择')
  picking = true
  try {
    const defaultPath = await existingPickerDefault(rawDefault)
    const plan = buildPickerPlan(process.platform, defaultPath)
    const result = await runPicker(plan)
    if (result.code !== 0) {
      if (isPickerCancel(process.platform, result.code, result.stderr)) {
        return { cancelled: true }
      }
      const detail = result.stderr.trim()
      throw new Error(
        detail === '' ? `目录选择失败（退出码 ${String(result.code)}）` : detail,
      )
    }
    const path = parsePickerOutput(result.stdout)
    return path === undefined ? { cancelled: true } : { path, cancelled: false }
  } finally {
    picking = false
  }
}

interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

function runPicker(plan: PickerPlan): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      env: plan.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) return
      chunks.push(chunk)
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(err))
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            process.platform === 'linux'
              ? '系统里找不到 zenity，无法弹出目录选择框；请直接输入绝对路径'
              : `无法启动目录选择框：${error.message}`,
          ),
        )
        return
      }
      reject(error)
    })
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}
