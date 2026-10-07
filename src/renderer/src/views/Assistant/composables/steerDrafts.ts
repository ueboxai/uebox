/**
 * 插话撤回后「放回输入框」用的草稿。
 *
 * 撤回的意思是「这句我还要改」：话没发出去，从时间线上拿掉，原样回到输入框里
 * 让用户接着编辑。文字、图片、表格、文档都得回来 —— 少一样，用户就得重新去找那个文件。
 *
 * 输入框发出插话时手上有完整的附件对象（解析好的表格、文档、上传好的图），
 * 时间线上只记了文件名，靠它还原不出来。所以发出那一刻把输入框的「放回」
 * 闭包按 `steerId` 存在这里，撤回时取出来调一下。
 *
 * 只放内存：撤回只在这一轮还在跑时可点，跨不过重启。条目在插话生效时放掉，
 * 另设上限，防止一轮里插了很多次、一次都没撤时一直攥着附件不放。
 */

const MAX_DRAFTS = 20

const drafts = new Map<string, () => void>()

/** 插话发出去了，记下撤回时怎么把它放回输入框 */
export function rememberSteerDraft(steerId: string, restore: () => void): void {
  drafts.delete(steerId)
  drafts.set(steerId, restore)
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value
    if (oldest === undefined) break
    drafts.delete(oldest)
  }
}

/** 撤回成功：取出放回的办法（取一次就没了） */
export function takeSteerDraft(steerId: string): (() => void) | undefined {
  const restore = drafts.get(steerId)
  drafts.delete(steerId)
  return restore
}

/** 插话已经进了上下文，再也撤不回来，草稿可以放掉了 */
export function forgetSteerDraft(steerId: string): void {
  drafts.delete(steerId)
}
