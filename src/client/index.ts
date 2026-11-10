/**
 * dsh-plugin-litsearch —— 客户端入口。
 *
 * 注册：
 * - 右侧栏「文献检索」主页（新建检索 + 历史任务）；
 * - `litsearch-task` 资源 tab（一次检索任务一个 tab，含标题席位）；
 * - 设置对话框里的「文献检索」页；
 * - 模型任务的自动打开轮询（`startAutoOpen`）。
 *
 * 注意：cordis 的对象式 inject 是「拦截 config」，不是 {required,optional}，
 * 因此这里用数组式 inject。
 */

import { createElement, useEffect, type ComponentType, type ReactElement } from 'react'

import { activateTask } from './api'
import {
  ensureTaskTitle,
  rememberTaskTitle,
  startAutoOpen,
  useTaskTitle,
} from './autoOpen'
import { refreshHealth } from './health'
import type { InputActions } from './inline'
import { LitsearchPage } from './LitsearchPage'
import { dicts, NS, type Translate } from './locales'
import { PAPER_ADDRESS_PREFIX, PaperPane } from './PaperPane'
import { LitsearchSettingsController, ROW_ID } from './SettingsController'
import { SettingsSection } from './SettingsSection'
import { TASK_ADDRESS_PREFIX, TaskPane, taskIdFromAddress } from './TaskPane'

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

/** 右侧栏导航服务（只用到按资源地址打开）。 */
interface SidebarRightService {
  openResource(address: string, options?: { params?: unknown }): void
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

export const name = 'dsh-plugin-litsearch'
export const inject = [
  'slots',
  'locale',
  'sidebarRightTabs',
  'sidebarRight',
  'configForms',
]

export function apply(ctx: ClientContext): void {
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

  /** 打开 / 聚焦某任务的 tab；先把标题记进缓存，布局恢复后不靠 params 也能显示。 */
  const openTask = (id: string, title?: string): void => {
    const address = `${TASK_ADDRESS_PREFIX}${encodeURIComponent(id)}`
    if (title !== undefined && title !== '') rememberTaskTitle(id, title)
    // 用户主动点开某任务 = 进入该任务，之后的模型检索默认落在这里。
    // 自动打开路径也会调用，但 activate 是幂等的，不会改变已有语义。
    void activateTask(id).catch(() => undefined)
    ctx.sidebarRight.openResource(
      address,
      title === undefined || title === '' ? undefined : { params: { title } },
    )
  }

  // 主页：t 闭包 + 打开任务 tab 的能力。
  const Body = (): ReactElement =>
    createElement(LitsearchPage, {
      t,
      onOpenTask: (id: string, title: string) => openTask(id, title),
    })

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
      ctx.configForms.whileServed([ROW_ID], () =>
        ctx.slots.inject('settings.section', () =>
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
        ),
      ),
    'dsh-plugin-litsearch: settings section',
  )

  // 模型任务的自动打开：首次轮询只对齐版本号，之后只打开新任务。
  ctx.effect(
    () =>
      startAutoOpen({
        open: (id, title) => openTask(id, title),
      }),
    'dsh-plugin-litsearch: auto open',
  )

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
