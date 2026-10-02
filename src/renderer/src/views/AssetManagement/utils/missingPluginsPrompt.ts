import { h, type VNode } from 'vue'
import i18n from '@renderer/i18n'
import { confirmDialog, warningDialog } from '@renderer/utils/dialog'
import { message } from '@renderer/utils/messageManager'
import type { MissingPlugin, UnavailablePlugin } from '@core/shared/projectImport'

const mutedStyle = 'color:var(--color-text-secondary);font-size:12px'

const describeUnavailable = (p: UnavailablePlugin): VNode => {
  const t = i18n.global.t
  const title = p.friendlyName !== p.name ? `${p.friendlyName}（${p.name}）` : p.name
  const notes: string[] = []
  if (p.kind === 'project-code') {
    notes.push(
      p.sourceProject
        ? t('importToProjectModal.missingPlugins.projectCode', { project: p.sourceProject })
        : t('importToProjectModal.missingPlugins.projectCodeUnknown')
    )
  } else if (p.kind === 'unknown') {
    notes.push(t('importToProjectModal.missingPlugins.onlyModuleName'))
  } else {
    if (p.versionName) notes.push(`v${p.versionName}`)
    if (p.sourceProject) {
      notes.push(t('importToProjectModal.missingPlugins.fromProject', { project: p.sourceProject }))
    }
  }
  return h('li', { key: `${p.kind}:${p.name}` }, [
    h('span', title),
    notes.length > 0
      ? h('span', { style: `${mutedStyle};margin-left:6px` }, notes.join(' · '))
      : null,
    p.fabUrl
      ? h(
          'a',
          {
            style: 'margin-left:8px;font-size:12px',
            onClick: (e: MouseEvent) => {
              e.preventDefault()
              void window.api.shell.openExternal(p.fabUrl as string)
            }
          },
          t('importToProjectModal.missingPlugins.openFab')
        )
      : null
  ])
}

/**
 * 导入完发现插件问题时说一声。
 *
 * - 本机有、工程没开的（`missing`）：问一句，用户点了才写 `.uproject`。不替他默默写 ——
 *   开插件要重启编辑器，有的插件还会拖慢启动，这是他的工程。
 * - 本机根本没有的（`unavailable`）：只能告诉他缺什么、去哪装。
 *
 * 资产库的导入弹窗和挂件上的「重试」都走这里，问法只有一套。
 */
export const promptEnableMissingPlugins = (
  project: Parameters<typeof window.api.projectImport.enablePlugins>[0],
  missing: MissingPlugin[] | undefined,
  unavailable?: UnavailablePlugin[]
): void => {
  const plugins = missing ?? []
  const absent = unavailable ?? []
  if (plugins.length === 0 && absent.length === 0) return
  const t = i18n.global.t

  const unavailableSection = absent.length
    ? [
        h(
          'p',
          { style: 'margin:12px 0 8px' },
          plugins.length > 0
            ? `${t('importToProjectModal.missingPlugins.unavailableTitle', { count: absent.length })}。${t('importToProjectModal.missingPlugins.unavailableDesc')}`
            : t('importToProjectModal.missingPlugins.unavailableDesc')
        ),
        h('ul', { style: 'margin:0 0 8px;padding-left:20px' }, absent.map(describeUnavailable)),
        h(
          'p',
          { style: `margin:0;${mutedStyle}` },
          t('importToProjectModal.missingPlugins.unavailableHint')
        )
      ]
    : []

  // 只有本机没有的：没什么可以替他做的，一个「知道了」就够
  if (plugins.length === 0) {
    warningDialog({
      title: t('importToProjectModal.missingPlugins.unavailableTitle', { count: absent.length }),
      width: 520,
      content: h('div', { style: 'line-height:1.7' }, unavailableSection),
      okText: t('importToProjectModal.missingPlugins.gotIt')
    })
    return
  }

  confirmDialog({
    title: t('importToProjectModal.missingPlugins.title', { count: plugins.length }),
    width: 520,
    content: h('div', { style: 'line-height:1.7' }, [
      h(
        'p',
        { style: 'margin:0 0 8px' },
        t('importToProjectModal.missingPlugins.desc', { project: project.projectName || '' })
      ),
      h(
        'ul',
        { style: 'margin:0 0 8px;padding-left:20px' },
        plugins.map((p) =>
          h(
            'li',
            { key: p.name },
            p.friendlyName === p.name ? p.name : `${p.friendlyName}（${p.name}）`
          )
        )
      ),
      h(
        'p',
        { style: `margin:0;${mutedStyle}` },
        t('importToProjectModal.missingPlugins.restartHint')
      ),
      ...unavailableSection
    ]),
    okText: t('importToProjectModal.missingPlugins.enable'),
    cancelText: t('importToProjectModal.missingPlugins.later'),
    onOk: async () => {
      const result = await window.api.projectImport.enablePlugins(
        project,
        plugins.map((p) => p.name)
      )
      if (result?.success) {
        message.success(
          t('importToProjectModal.missingPlugins.done', {
            count: result.enabled?.length ?? plugins.length
          })
        )
      } else {
        message.error(
          t('importToProjectModal.missingPlugins.failed', { error: result?.error || '' })
        )
      }
    }
  })
}
