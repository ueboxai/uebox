/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ProfileAI from './ProfileAI.vue'

/**
 * 「目标模式最多几轮」。主进程按它停，这里是唯一入口：读得回已存的值、
 * 失焦才存、乱填的数夹回范围后输入框跟着显示真正存下的那个。
 */

const appSettingsGet = vi.fn()
const appSettingsSet = vi.fn()

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('./ArchivedChatsModal.vue', () => ({ default: { template: '<div />' } }))

async function mountInput(): Promise<{
  wrapper: ReturnType<typeof mount>
  input: ReturnType<ReturnType<typeof mount>['get']>
}> {
  const wrapper = mount(ProfileAI, { global: { mocks: { $t: (key: string) => key } } })
  await flushPromises()
  return { wrapper, input: wrapper.get('input[aria-label="profile.ai.goalMaxRounds"]') }
}

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  appSettingsGet.mockResolvedValue({ agentGoalMaxRounds: 20 })
  appSettingsSet.mockResolvedValue({ success: true })
  ;(window as unknown as { api: unknown }).api = {
    appSettings: { get: appSettingsGet, set: appSettingsSet },
    invoke: vi.fn(async () => undefined)
  }
})

describe('AI 设置 · 目标模式最多几轮', () => {
  it('显示已存的值，打开页面不回写', async () => {
    const { wrapper, input } = await mountInput()

    expect((input.element as HTMLInputElement).value).toBe('20')
    expect(appSettingsSet).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('失焦时把新值交给主进程', async () => {
    const { wrapper, input } = await mountInput()

    await input.setValue('30')
    expect(appSettingsSet).not.toHaveBeenCalled()
    await input.trigger('blur')
    await flushPromises()

    expect(appSettingsSet).toHaveBeenCalledWith({ agentGoalMaxRounds: 30 })
    wrapper.unmount()
  })

  it('越界的数夹回范围再存，输入框显示存下的那个', async () => {
    const { wrapper, input } = await mountInput()

    await input.setValue('999')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(appSettingsSet).toHaveBeenCalledWith({ agentGoalMaxRounds: 50 })
    expect((input.element as HTMLInputElement).value).toBe('50')
    wrapper.unmount()
  })
})
