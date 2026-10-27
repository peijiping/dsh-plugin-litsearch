/**
 * 检索层常量与运行时设置。
 *
 * 设置由插件入口在 `apply` 时注入，读取时逐次走 volatile 引用，因此插件页
 * 保存配置后无需重启即生效。
 */

/** 默认返回条数。 */
export const DEFAULT_LIMIT = 20

/** 单次上游请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 15_000

/** 返回条数上限，防止一次请求拉爆上游与宿主。 */
export const MAX_LIMIT = 50

/** Host 路由前缀（Client fetch 路径与 handler 的剥离基准，带尾斜杠）。 */
export const ROUTE_PREFIX = '/dsh-litsearch/api/'

/**
 * 注册到 `webServer` 的 prefix 路径。
 *
 * 必须**不带尾斜杠**：宿主按 `pathname === prefix || pathname.startsWith(prefix + '/')`
 * 匹配，带尾斜杠会变成 `.../api//search`，永远匹配不上。
 */
export const ROUTE_MATCH = '/dsh-litsearch/api'

export interface LitsearchSettings {
  /** 联系邮箱，作为 OpenAlex / Crossref polite pool 标识；留空也可用。 */
  contactEmail: string
  defaultLimit: number
  requestTimeoutMs: number
}

/** 默认读取器：入口未注入时回落到常量。 */
let readSettings = (): LitsearchSettings => ({
  contactEmail: '',
  defaultLimit: DEFAULT_LIMIT,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
})

/** 由插件入口在 `apply` 时注入。 */
export function setSettingsReader(reader: () => LitsearchSettings): void {
  readSettings = reader
}

/** 读取当前生效的设置。 */
export function getSettings(): LitsearchSettings {
  return readSettings()
}
