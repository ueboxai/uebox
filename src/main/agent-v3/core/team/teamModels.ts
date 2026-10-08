/**
 * 队员用哪个模型。
 *
 * 谁招人谁配模型：用户不知道制作人会招哪些人，没法事先按人指定，所以由制作人招人时
 * 从用户配好的模型里挑，并写一句理由；用户在任务板上看得到、改得动。
 * 设计见 docs/团队选模型与履历设计-2026-10-08.md。
 *
 * 这里只放和工具无关的那几样：候选名单怎么写给制作人、派活那一刻实际用哪个模型。
 */

import {
  sameTeamModel,
  teamModelCandidates,
  teamModelLabel,
  type TeamMember,
  type TeamModel,
  type TeamModelCandidate
} from '../../../../shared/agentTeam'
import type { TeamStore } from './teamStore'

export interface TeamModels {
  /** 招人能挑的模型，按设置页里的顺序 */
  candidates: TeamModelCandidate[]
  /** 制作人这一轮用的模型 */
  producer?: TeamModel
  /** 派活那一刻这个模型还能不能用（来源删了、模型下架了就不能） */
  isAvailable: (model: TeamModel) => Promise<boolean>
}

/** 只有一个能用的模型时没得挑：招人工具里不出现这一项，派活回话里也不提模型 */
export function canChooseModels(models: TeamModels | undefined): models is TeamModels {
  return (models?.candidates.length ?? 0) > 1
}

/** 给人看的模型名：名单里有就用展示名，没有（来源删了）就用模型 id */
export function modelLabel(models: TeamModels | undefined, model: TeamModel): string {
  return teamModelLabel(models?.candidates ?? [], model)
}

/** 上下文长度写成 128k 这样，制作人一眼比得出大小 */
function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : `${Math.round(tokens / 1000)}k`
}

/**
 * 写进招人工具说明里的候选名单。只写事实：哪一家、能不能看图、上下文多长。
 * 不写「审核该用另一家」这类规则 —— 怎么搭由制作人判断（见设计稿 5.1 节）。
 */
export function describeCandidates(models: TeamModels): string {
  return models.candidates
    .map((c) => {
      const facts = [
        c.providerName,
        c.vision ? '能看图' : '看不了图',
        ...(c.contextWindow ? [`上下文 ${formatContext(c.contextWindow)}`] : [])
      ]
      const mine = sameTeamModel(c, models.producer) ? ' ← 你自己用的' : ''
      return `- ${c.key}：${c.name}（${facts.join('，')}）${mine}`
    })
    .join('\n')
}

export interface MemberRoute {
  /** 钉给这个队员的模型。不给 = 沿用老规矩（制作人的模型，或 `fast` 档的对话模型） */
  pin?: TeamModel
  /** 这件活实际用的模型，记账和回话用。说不准（老 `fast` 档）时不给 */
  used?: TeamModel
  /** 它的模型这会儿用不了，这件活改用制作人的 */
  fellBack: boolean
}

/**
 * 派活那一刻这个队员用哪个模型。
 *
 * 它的模型用不了时不报错、不停活：这一件改用制作人的模型，回话里说一声，名册不动 ——
 * 用户把来源补回来，下一件就又用回去了。
 */
export async function routeMember(
  models: TeamModels | undefined,
  member: TeamMember
): Promise<MemberRoute> {
  if (member.model) {
    if (!models || (await models.isAvailable(member.model))) {
      return { pin: member.model, used: member.model, fellBack: false }
    }
    return { ...(models.producer ? { used: models.producer } : {}), fellBack: true }
  }
  // 老名册：strong 跟着制作人；fast 走对话模型，具体是哪个这里说不准
  if (member.tier === 'fast') return { fellBack: false }
  return { ...(models?.producer ? { used: models.producer } : {}), fellBack: false }
}

/**
 * 从模型设置读出这一轮的候选名单。读不到设置就不给 —— 招人照常，只是不让挑模型。
 *
 * 懒加载 `ai/store`：它顶上静态引了 electron，团队工具的单测不该为此加载它。
 */
export async function loadTeamModels(producer: TeamModel): Promise<TeamModels | undefined> {
  const { readSettings } = await import('../../../ai/store')
  try {
    const settings = await readSettings()
    return {
      candidates: teamModelCandidates(settings.providers),
      producer,
      // 和任务板、换模型 IPC 同一条规矩：在候选名单里才算能用。名单本身已经要求是对话类来源、
      // 模型还在清单里，另外去掉了标明不能调工具的 —— 两边各判一次的话，界面标黄而派活照用
      isAvailable: async (model) =>
        teamModelCandidates((await readSettings()).providers).some((c) => sameTeamModel(c, model))
    }
  } catch (error) {
    console.warn('[team] 读模型设置失败，这一轮招人不给挑模型:', error)
    return undefined
  }
}

/**
 * 用户在任务板上给队员换模型（IPC `agent-v3:team-member-model`）。
 *
 * 只收候选名单里的模型；记成「用户定的」；制作人当初的理由说的是原来那个模型，换了就清掉。
 */
export async function assignMemberModel(
  store: TeamStore,
  candidates: readonly TeamModelCandidate[],
  name: string,
  model: TeamModel
): Promise<{ success: true } | { success: false; error: string }> {
  const member = await store.findMember(name)
  if (!member) return { success: false, error: `团队里没有 ${name}` }
  if (!candidates.some((c) => sameTeamModel(c, model))) {
    return { success: false, error: `${model.providerId}/${model.modelId} 不在能用的模型里` }
  }
  const next: TeamMember = {
    ...member,
    model: { providerId: model.providerId, modelId: model.modelId },
    modelBy: 'user'
  }
  delete next.modelReason
  await store.putMember(next)
  return { success: true }
}
