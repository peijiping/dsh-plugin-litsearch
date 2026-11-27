/**
 * dsh-plugin-litsearch —— 客户端入口。
 *
 * 注册：
 * - 右侧栏「文献检索」主页（新建检索 + 历史任务）；
 * - `litsearch-task` 资源 tab（一次检索任务一个 tab，含标题席位）；
 * - 设置对话框里的「文献检索」页；
 * - 模型任务的自动打开轮询（`startAutoOpen`）。
 *
 * 主页与任务页共用同一个「检索页」名额：同一会话的右侧栏里只留一个，
 * 分栏 / 浮动面板里多开出来的会被自动关闭；论文详情 tab 不受限制。
 * 已有检索页时再点插件入口只聚焦它，不会把任务页换成「新建检索」。
 *
 * 注意：cordis 的对象式 inject 是「拦截 config」，不是 {required,optional}，
 * 因此这里用数组式 inject。
 */

import {
  createElement,
  useEffect,
  useLayoutEffect,
  type ComponentType,
  type ReactElement,
} from 'react'

import {
  ApiFailure,
  activateTask,
  fetchTask,
  finishPanelCommand,
  recheckPaperPdf,
  revealLocalFile,
  setSessionIdProvider,
} from './api'
import {
  ensureTaskTitle,
  forgetTask,
  getTaskTitle,
  rememberTaskTitle,
  startAutoOpen,
  useTaskTitle,
} from './autoOpen'
import { GuideIcon, type GuideIconProps } from './GuideIcon'
import { refreshHealth } from './health'
import type { InputActions } from './inline'
import { LitsearchPage } from './LitsearchPage'
import { dicts, NS, tpl, type Translate } from './locales'
import { showNotice } from './noticeStore'
import { notifyTaskListChanged } from './taskListStore'
import { queuePanelCommand, rememberPanelCommand } from './panelCommands'
import { PAPER_ADDRESS_PREFIX, PaperPane } from './PaperPane'
import { LitsearchSettingsController, ROW_ID } from './SettingsController'
import { SettingsNavIcon } from './SettingsNavIcon'
import { SettingsSection } from './SettingsSection'
import { TASK_ADDRESS_PREFIX, TaskPane, taskIdFromAddress } from './TaskPane'
import { installTheme } from './theme'

/** locale 服务中本插件用到的那部分。 */
interface LocaleService {
  register(
    namespace: string,
    dicts: { zh: Record<string, string>; en: Record<string, string> },
  ): unknown
  bind(namespace: string): Translate
}

/** guide 入口项（kind / providerId 由注册表注入）。 */
interface GuideEntry {
  id: string
  title: () => string
  description?: () => string
  order?: number
  icon?: ComponentType<GuideIconProps>
}

/** 右侧栏 tab 类型定义。 */
interface TabDefinition {
  id: string
  kind: string
  title: (address: string) => string
  multiple?: boolean
  keepMounted?: boolean
  patterns?: readonly string[]
  priority?: 'extension' | 'builtin' | 'fallback'
  guide?: readonly GuideEntry[]
}

/** 右侧栏 tab 类型注册表。 */
interface SidebarRightTabsService {
  register(definition: TabDefinition): unknown
}

/** 右侧栏里一个已打开的 tab（只声明本插件用到的字段）。 */
interface SidebarRightOpenTab {
  id: string
  kind: string
  contentId: string
}

/** 右侧栏导航服务：打开资源 + 读取 / 关闭当前会话已打开的 tab。 */
interface SidebarRightService {
  openResource(
    address: string,
    options?: { params?: unknown; replaceTab?: string; revealIfOpened?: boolean },
  ): void
  close(tabId: string): void
  focus(tabId: string): void
  active(): SidebarRightOpenTab | undefined
  mounted: {
    getSnapshot(): string | undefined
    subscribe(listener: () => void): () => void
  }
  tabsIn(sessionId: string): readonly SidebarRightOpenTab[]
}

/** slots 服务。 */
interface SlotsService {
  register(meta: Record<string, unknown>, component: ComponentType<never>): unknown
  inject(key: string, callback: () => unknown): () => void
}

/** 配置表单服务（由 `@deepseek-ai/dsh-client-ui-settings` 提供）。 */
interface ConfigFormsService {
  get(entryId: string): unknown
  whileServed(
    namespaces: string[],
    register: (served: Set<string>) => () => void,
  ): () => void
}

interface ClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sidebarRightTabs: SidebarRightTabsService
  sidebarRight: SidebarRightService
  configForms: ConfigFormsService
}

/** 主页 tab 类型 id，同时用作 `sidebar.right.pane.tab` 席位的 key。 */
const TAB_ID = 'litsearch'

/** 任务 tab 的类型 id / kind；正文与标题席位也按这个 key 注册。 */
const TASK_TAB_ID = 'litsearch-task'

/** 独立论文 tab 的类型 id / kind。 */
const PAPER_TAB_ID = 'litsearch-paper'

/** 设置对话框里这一页的 section id。 */
const SETTINGS_SECTION_ID = 'litsearch'

const HEALTH_REFRESH_MS = 30_000

/** 文件资源地址：与 DSH 文档预览 tab 使用的 `dsh-resource://file/session/...` 保持一致。 */
function localFileAddress(sessionId: string, path: string): string {
  const encode = (segment: string): string => encodeURIComponent(segment).replace(/%3A/gi, ':')
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`
}

export const name = 'dsh-plugin-litsearch'
export const inject = [
  'slots',
  'locale',
  'sidebarRightTabs',
  'sidebarRight',
  'configForms',
]

export function apply(ctx: ClientContext): void {
  // 令牌与工具类必须在任何 slot 渲染之前进 head，否则首帧是无样式闪动。
  ctx.effect(() => installTheme(), 'dsh-plugin-litsearch: theme')
  // 所有端点都带上当前会话 id，Host 据此把任务关联到会话工作目录。
  setSessionIdProvider(() => ctx.sidebarRight.mounted.getSnapshot())
  ctx.effect(() => ctx.locale.register(NS, dicts), 'dsh-plugin-litsearch: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        title: () => t('tab.title'),
        guide: [
          {
            id: TAB_ID,
            title: () => t('guide.title'),
            description: () => t('guide.desc'),
            order: 20,
            icon: GuideIcon,
          },
        ],
      }),
    'dsh-plugin-litsearch: sidebar tab',
  )

  // 一次检索任务一个资源 tab；地址稳定，重复打开只聚焦已有 tab。
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TASK_TAB_ID,
        kind: TASK_TAB_ID,
        title: () => t('taskTab.title'),
        patterns: ['dsh-resource://litsearch-task/**'],
        priority: 'extension',
        keepMounted: true,
      }),
    'dsh-plugin-litsearch: task tab',
  )

  // 单篇论文一个资源 tab；从结果卡片或论文页内跳转。
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: PAPER_TAB_ID,
        kind: PAPER_TAB_ID,
        title: () => t('paperTab.title'),
        patterns: ['dsh-resource://litsearch-paper/**'],
        priority: 'extension',
        keepMounted: true,
      }),
    'dsh-plugin-litsearch: paper tab',
  )

  /** 当前会话里已打开的任务 tab。 */
  const taskTabsIn = (sessionId: string): SidebarRightOpenTab[] =>
    ctx.sidebarRight.tabsIn(sessionId).filter((tab) => tab.kind === TASK_TAB_ID)

  /** 检索页：主页与任务页共用唯一名额，论文详情不计入。 */
  const searchTabsIn = (sessionId: string): SidebarRightOpenTab[] =>
    ctx.sidebarRight.tabsIn(sessionId).filter(
      (tab) => tab.kind === TAB_ID || tab.kind === TASK_TAB_ID,
    )

  /**
   * 把会话内的检索页收敛到一个。
   *
   * 主页是「按 pane 去重」的页面类型，分栏 / 浮动面板里可以各开一份；任务页
   * 也可能从旧布局里遗留多份。大模型只有一个「当前任务」，界面上也只留一个
   * 检索页，才不会出现「到底控制哪个面板」的歧义。优先保留当前激活的 tab，
   * 否则保留刚打开的目标地址，再退到任务页 / 最后一个。
   */
  const convergeSearchTabs = (preferredAddress?: string): void => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (sessionId === undefined) return
    const tabs = searchTabsIn(sessionId)
    if (tabs.length <= 1) return
    const activeId = ctx.sidebarRight.active()?.id
    const keeper =
      tabs.find((tab) => tab.id === activeId) ??
      (preferredAddress === undefined
        ? undefined
        : tabs.find((tab) => tab.contentId === preferredAddress)) ??
      tabs.find((tab) => tab.kind === TASK_TAB_ID) ??
      tabs[tabs.length - 1]
    for (const tab of tabs) {
      if (tab.id !== keeper.id) ctx.sidebarRight.close(tab.id)
    }
  }

  /** 上一次成功打开的任务：目标任务随后失效时，任务页可一键切回。 */
  let previousTask: { id: string; title: string } | null = null
  /** 连续点击多个任务时只让最后一次生效，避免预检请求乱序。 */
  let openSeq = 0

  /**
   * 打开 / 聚焦某任务的 tab。
   *
   * 先向 Host 确认任务仍然存在再替换当前 tab：任务被删除 / 自动清理后，
   * 直接换 tab 只会让面板停在「任务不存在」上，而且原来的 tab 已经没了。
   * 预检失败只提醒、不切换。
   */
  const openTask = (id: string, title?: string): void => {
    const intendedSession = ctx.sidebarRight.mounted.getSnapshot()
    const token = ++openSeq
    void fetchTask(id)
      .then((detail) => {
        if (token !== openSeq || intendedSession !== ctx.sidebarRight.mounted.getSnapshot()) return
        rememberTaskTitle(detail.id, detail.title)
        const address = `${TASK_ADDRESS_PREFIX}${encodeURIComponent(detail.id)}`
        // 一个对话只保留一个检索页：已有任务页 / 主页时原位替换，不再另开。
        const sessionId = ctx.sidebarRight.mounted.getSnapshot()
        const tabs = sessionId === undefined ? [] : searchTabsIn(sessionId)
        const previous =
          tabs.find(
            (tab) => tab.kind === TASK_TAB_ID && taskIdFromAddress(tab.contentId) !== detail.id,
          ) ?? tabs.find((tab) => taskIdFromAddress(tab.contentId) !== detail.id)
        if (previous !== undefined) {
          const previousId = taskIdFromAddress(previous.contentId)
          if (previousId !== null && previousId !== detail.id) {
            previousTask = {
              id: previousId,
              title: getTaskTitle(previousId) ?? t('taskTab.title'),
            }
          }
        }
        ctx.sidebarRight.openResource(address, {
          params: { title: title === undefined || title === '' ? detail.title : title },
          ...(previous === undefined ? {} : { replaceTab: previous.id }),
        })
        // 分栏里可能还留着别处的检索页（含同一任务的重复 tab）：统一收敛到这一个。
        convergeSearchTabs(address)
        // 用户主动点开某任务 = 进入该任务，之后的模型检索默认落在这里。
        // 自动打开路径也会调用，但 activate 是幂等的，不会改变已有语义。
        void activateTask(detail.id).catch(() => undefined)
      })
      .catch((error: unknown) => {
        if (token !== openSeq || intendedSession !== ctx.sidebarRight.mounted.getSnapshot()) return
        if (error instanceof ApiFailure && error.code === 'not_found') {
          // 清掉本地标题 / 待打开缓存，并让所有任务列表刷新掉这条已失效的记录。
          forgetTask(id)
          notifyTaskListChanged()
          showNotice(tpl(t('task.missingNotice'), { id }))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        showNotice(tpl(t('task.openFailed'), { message }))
      })
  }

  /**
   * 再次点插件入口时的语义：不把已打开的检索页换成「新建检索」。
   *
   * 入口本身只会 `openTab('litsearch')`，宿主不知道这里已有任务页，于是新主页
   * 会在当前 pane 里闪出来。主页挂载时检查一次：已有任务页就关掉自己、把任务页
   * 聚焦回前台；有多份主页只留最早那份。没有别的检索页时才是真正的新建入口。
   */
  const yieldToExistingSearchPage = (selfId: string): void => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (sessionId === undefined) return
    const tabs = searchTabsIn(sessionId)
    if (tabs.length <= 1) return
    const task = tabs.find((tab) => tab.kind === TASK_TAB_ID)
    if (task !== undefined) {
      if (selfId !== task.id) ctx.sidebarRight.close(selfId)
      for (const extra of tabs) {
        if (extra.kind === TASK_TAB_ID && extra.id !== task.id) ctx.sidebarRight.close(extra.id)
      }
      ctx.sidebarRight.focus(task.id)
      return
    }
    const keeper = tabs.find((tab) => tab.kind === TAB_ID)
    if (keeper === undefined) return
    if (keeper.id !== selfId) ctx.sidebarRight.close(selfId)
    for (const tab of tabs) {
      if (tab.id !== keeper.id) ctx.sidebarRight.close(tab.id)
    }
    ctx.sidebarRight.focus(keeper.id)
  }

  // 主页：t 闭包 + 打开任务 tab 的能力。入口重复点击时让位给已打开的检索页；
  // 论文详情 tab 不计入、不受影响。
  const Body = (props: {
    useTabInfo: () => { tab: { id?: string } }
  }): ReactElement => {
    const selfId = props.useTabInfo().tab.id
    useLayoutEffect(() => {
      if (typeof selfId === 'string' && selfId !== '') yieldToExistingSearchPage(selfId)
    }, [])
    return createElement(LitsearchPage, {
      t,
      onOpenTask: (id: string, title: string) => openTask(id, title),
    })
  }

  /** 关闭某个任务 tab；任务被删除且没有可切换的任务时用来清空窗口。 */
  const closeTask = (id: string): void => {
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (sessionId === undefined) return
    for (const tab of taskTabsIn(sessionId)) {
      if (taskIdFromAddress(tab.contentId) === id) ctx.sidebarRight.close(tab.id)
    }
  }

  ctx.effect(
    () =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: TAB_ID },
        Body as ComponentType<never>,
      ),
    'dsh-plugin-litsearch: pane body',
  )

  type TaskPaneProps = Parameters<typeof TaskPane>[0]

  /** 打开 / 聚焦单篇论文 tab；标题通过 params 传给标题席位。 */
  const openPaper = (taskId: string, paperId: string, title: string): void => {
    const address = `${PAPER_ADDRESS_PREFIX}${encodeURIComponent(taskId)}/${encodeURIComponent(paperId)}`
    ctx.sidebarRight.openResource(address, title === '' ? undefined : { params: { title } })
  }

  /**
   * 在右侧栏用 DSH 文档预览打开已下载的本地 PDF。
   * 页面加载后文件可能被删除，先让 Host 复核一次；缺失时状态会广播为
   * `missing`，按钮随即变成「下载文件已删除点击重新下载」。
   */
  const openPdfPreview = (taskId: string, paperId: string, path: string): void => {
    void recheckPaperPdf(taskId, paperId)
      .then((result) => result.exists)
      .catch(() => true)
      .then((exists) => {
        if (!exists || path === '') return
        const sessionId = ctx.sidebarRight.mounted.getSnapshot()
        if (sessionId === undefined) return
        ctx.sidebarRight.openResource(localFileAddress(sessionId, path), { revealIfOpened: true })
      })
  }

  /** 在系统文件管理器中打开下载目录并选中该 PDF（失败时静默，避免打断阅读）。 */
  const revealPdf = (path: string): void => {
    if (path === '') return
    void revealLocalFile(path).catch(() => undefined)
  }

  const TaskBody = (props: {
    inputActions?: InputActions
    useTabInfo: TaskPaneProps['useTabInfo']
  }): ReactElement =>
    createElement(TaskPane, {
      t,
      useTabInfo: props.useTabInfo,
      inputActions: props.inputActions,
      onOpenPaper: openPaper,
      onOpenTask: (id: string, title: string) => openTask(id, title),
      onCloseTask: (id: string) => closeTask(id),
      getPreviousTask: () => previousTask,
      currentSession: () => ctx.sidebarRight.mounted.getSnapshot(),
      onOpenLocal: openPdfPreview,
      onRevealLocal: revealPdf,
    })

  /** tab 标题：按地址里的任务 id 读缓存，缺了补取一次详情。 */
  const TaskTitle = (props: { useTabInfo: TaskPaneProps['useTabInfo'] }): ReactElement => {
    const info = props.useTabInfo()
    const navigation = info.tab.navigation
    const id = taskIdFromAddress(navigation?.address || info.tab.contentId || '')
    const params = navigation?.params as { title?: unknown } | undefined
    const openedTitle =
      typeof params?.title === 'string' && params.title !== '' ? params.title : undefined
    const cached = useTaskTitle(id)

    useEffect(() => {
      if (id !== null && cached === undefined) ensureTaskTitle(id)
    }, [id, cached])

    const title = cached ?? openedTitle ?? t('taskTab.title')
    return createElement(
      'span',
      { title, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      title,
    )
  }

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TASK_TAB_ID },
          TaskBody as ComponentType<never>,
        ),
      ),
    'dsh-plugin-litsearch: task body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: TASK_TAB_ID },
          TaskTitle as ComponentType<never>,
        ),
      ),
    'dsh-plugin-litsearch: task title',
  )

  type PaperPaneProps = Parameters<typeof PaperPane>[0]

  const PaperBody = (props: {
    inputActions?: InputActions
    useTabInfo: PaperPaneProps['useTabInfo']
  }): ReactElement =>
    createElement(PaperPane, {
      t,
      useTabInfo: props.useTabInfo,
      inputActions: props.inputActions,
      onOpenLocal: openPdfPreview,
      onRevealLocal: revealPdf,
    })

  const PaperTitle = (props: {
    useTabInfo: PaperPaneProps['useTabInfo']
  }): ReactElement => {
    const info = props.useTabInfo()
    const params = info.tab.navigation?.params as { title?: unknown } | undefined
    const title =
      typeof params?.title === 'string' && params.title !== ''
        ? params.title
        : t('paperTab.title')
    return createElement(
      'span',
      { title, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      title,
    )
  }

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: PAPER_TAB_ID },
          PaperBody as ComponentType<never>,
        ),
      ),
    'dsh-plugin-litsearch: paper body',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab.title', key: PAPER_TAB_ID },
          PaperTitle as ComponentType<never>,
        ),
      ),
    'dsh-plugin-litsearch: paper title',
  )

  // 设置页：只有「设置」对话框里的独立一页，仅在 Host 服务本插件命名空间时注册。
  const controller = new LitsearchSettingsController(ctx.configForms.get(ROW_ID))
  ctx.effect(() => () => controller.dispose(), 'dsh-plugin-litsearch: settings form')
  ctx.effect(
    () =>
      ctx.configForms.whileServed([ROW_ID], () => {
        const offSection = ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: SETTINGS_SECTION_ID,
              order: 30,
              label: () => t('settings.nav'),
              locale: NS,
              inject: () => controller.inject(),
            },
            SettingsSection as ComponentType<never>,
          ),
        )
        // 左导航图标是独立席位：外壳按 section id 取 `settings.section.icon`，
        // 没注册就退回默认齿轮。id 必须与上面一致，两者生命周期也绑在一起。
        const offIcon = ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register(
            { name: 'settings.section.icon', id: SETTINGS_SECTION_ID },
            SettingsNavIcon as ComponentType<never>,
          ),
        )
        return () => {
          offSection()
          offIcon()
        }
      }),
    'dsh-plugin-litsearch: settings section',
  )

  // 模型任务的自动打开：首次轮询只对齐版本号，之后只打开新任务。
  ctx.effect(
    () =>
      startAutoOpen({
        open: (id, title) => openTask(id, title),
        sessionId: () => ctx.sidebarRight.mounted.getSnapshot(),
        removed: (ids) => {
          for (const id of ids) { forgetTask(id); closeTask(id) }
          notifyTaskListChanged()
        },
        panel: (commands) => {
          const sessionId = ctx.sidebarRight.mounted.getSnapshot()
          if (sessionId === undefined) return
          for (const command of commands) {
            if (command.sessionId !== sessionId || !rememberPanelCommand(command)) continue
            if (command.action === 'confirm') {
              const accepted = window.confirm(command.message)
              void finishPanelCommand(command.commandId, sessionId, accepted)
                .then((result) => {
                  if (result.status === 'done' || result.status === 'failed') {
                    showNotice(result.text)
                    notifyTaskListChanged()
                  }
                })
                .catch((error: unknown) => showNotice(String(error)))
              continue
            }
            if (command.action === 'paper') {
              openPaper(command.taskId, command.paperId, command.title)
              void finishPanelCommand(command.commandId, sessionId, true).catch((error: unknown) => showNotice(String(error)))
              continue
            }
            queuePanelCommand(command)
            openTask(command.taskId)
          }
        },
      }),
    'dsh-plugin-litsearch: auto open',
  )

  // 切换对话时，让「当前任务」跟随该对话里打开的那个任务 tab：
  // 模型下一轮执行前用 literature_task current 就能看到正确的任务。
  ctx.effect(() => {
    const sync = (): void => {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot()
      if (sessionId === undefined) return
      // 恢复的旧布局里可能还留着主页 / 多个任务页：先收敛成一个检索页。
      convergeSearchTabs()
      const tabs = taskTabsIn(sessionId)
      if (tabs.length === 0) return
      const activeId = ctx.sidebarRight.active()?.id
      const tab = tabs.find((entry) => entry.id === activeId) ?? tabs[0]
      const id = taskIdFromAddress(tab.contentId)
      if (id !== null) void activateTask(id).catch(() => undefined)
    }
    const unsubscribe = ctx.sidebarRight.mounted.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
    }
  }, 'dsh-plugin-litsearch: current task follows conversation')

  // 设置改动没有推送通道：定时刷新 /health，自动打开与默认值随之更新。
  ctx.effect(() => {
    void refreshHealth()
    const timer = setInterval(() => {
      void refreshHealth()
    }, HEALTH_REFRESH_MS)
    return () => {
      clearInterval(timer)
    }
  }, 'dsh-plugin-litsearch: health')
}
