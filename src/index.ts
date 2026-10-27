/**
 * dsh-plugin-litsearch —— 插件入口（Host 半）。
 *
 * 做三件事：
 * 1. 导出 Schemastery `Config`（逐字段 `.volatile()`），让 dsh「插件」页能
 *    渲染配置表单；保存后无需重启即生效。
 * 2. 把免费文献 API 的检索能力注册进 dsh 工具表（`literature_search` /
 *    `literature_sources`），模型无需本地服务即可检索。
 * 3. 在宿主 web server 上注册 `/dsh-litsearch/api/*` 只读端点，供右侧栏
 *    面板取数。
 *
 * `webServer` / `tools` 的类型不在已安装的 dsh 包里，因此自定义最小结构接口并
 * 强转（与 dsh-plugin-zotero 同法）。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { createHandler, type WebServerLike } from './host/router.js'
import { literatureTools, type ToolsService } from './host/tools.js'
import {
  DEFAULT_LIMIT,
  REQUEST_TIMEOUT_MS,
  ROUTE_MATCH,
  setSettingsReader,
} from './search/config.js'

export const name = 'dsh-plugin-litsearch'

/**
 * 插件配置 schema（逐字段 volatile）。
 *
 * volatile 是 dsh 配置表单的硬前提；用 `.volatile()` 后保存只提交新值并
 * 唤醒引用，条目本身不重挂，因此改配置无需重启 dsh。
 */
export const Config = Schema.object({
  /** 作为 OpenAlex / Crossref 的 polite pool 标识；留空也可用。 */
  contactEmail: Schema.string().default('').volatile(),
  defaultLimit: Schema.number().default(DEFAULT_LIMIT).volatile(),
  requestTimeoutMs: Schema.number().default(REQUEST_TIMEOUT_MS).volatile(),
})

export function apply(ctx: Context, config: Schemastery.TypeT<typeof Config>): void {
  // 每次读取都走 volatile 引用，始终拿到最新值。
  setSettingsReader(() => ({
    contactEmail: config.contactEmail.get(),
    defaultLimit: config.defaultLimit.get(),
    requestTimeoutMs: config.requestTimeoutMs.get(),
  }))

  // 模型侧：原生注册，不依赖外部 MCP。
  ctx.inject(['tools'], (toolCtx: Context) => {
    const toolsService = (toolCtx as unknown as { tools: ToolsService }).tools
    for (const definition of literatureTools()) {
      toolCtx.effect(
        () => toolsService.register(definition),
        `dsh-plugin-litsearch: ${definition.name}`,
      )
    }
  })

  // 人侧：右侧栏面板通过回环只读端点取数。
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const webServer = (hostCtx as unknown as { webServer: WebServerLike }).webServer
    const handler = createHandler()
    hostCtx.effect(
      () => webServer.register({ kind: 'prefix', path: ROUTE_MATCH, handler }),
      'dsh-plugin-litsearch: http routes',
    )
  })
}
