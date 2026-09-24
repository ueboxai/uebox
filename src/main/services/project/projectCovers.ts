import { createHash, randomUUID } from 'node:crypto'
import {
  mkdirSync,
  promises as fs,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { getSharp } from '../../utils/sharpLoader'
import {
  getAllProjects,
  deleteProjectByKey,
  getProjectByKey,
  updateProject,
  type ProjectRecord
} from '../../sqliteDataBase/models/project'
import { projectCoverMode, type ProjectCoverMode } from '../../../shared/projectCover'
import { projectComparisonKeyWithoutFs, projectThumbnailCandidates } from '../../utils/projectPath'

interface CoverState {
  version: 1
  mode: ProjectCoverMode
  image: string
}

const MAX_CONCURRENT_SCREENSHOTS = 4

/** Owns cover replacement so a failed index update cannot orphan the newly written image. */
export class ProjectCoverService {
  private pending = new Map<string, Promise<unknown>>()
  private signatures = new Map<string, string>()
  /** Source files that failed to decode; retried only once the file changes. */
  private rejected = new Map<string, string>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private stopped = true
  private activeScreenshotReads = 0
  private readonly screenshotWaiters: Array<() => void> = []

  constructor(
    private readonly db: Database.Database,
    private readonly thumbnailsDirectory: string,
    private readonly onChanged: () => void = () => {}
  ) {}

  start(): Promise<void> {
    if (!this.stopped) return this.running || Promise.resolve()
    this.stopped = false
    return this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running
    await Promise.allSettled(this.pending.values())
  }

  private tick(): Promise<void> {
    // Schedule independently of filesystem latency; sync skips projects still in flight.
    this.timer = setTimeout(() => {
      if (!this.stopped) void this.tick()
    }, 5000)
    this.timer.unref?.()
    this.running = this.sync().catch((error: unknown) => {
      console.warn('[ProjectCover] Scan failed:', error)
    })
    return this.running
  }

  save(projectKey: string, data: Uint8Array): Promise<string> {
    return this.enqueue(projectKey, () => this.replace(projectKey, data, 'custom'))
  }

  remove(projectKey: string): Promise<boolean> {
    return this.enqueue(projectKey, async () => {
      const project = getProjectByKey(this.db, projectKey)
      if (!project) return false
      const destination = this.statePath(project)
      const previous = this.readStateFile(destination)
      if (previous !== null) {
        this.decodeState(previous, true)
        unlinkSync(destination)
      }
      let removed: boolean
      try {
        removed = deleteProjectByKey(this.db, projectKey)
        if (!removed) throw new Error('Project no longer exists')
      } catch (error) {
        if (previous !== null) this.writeStateFile(destination, previous)
        throw error
      }
      this.forget(projectKey)
      await this.removeUnreferencedImage(project.image)
      this.notifyChanged()
      return removed
    })
  }

  async restoreAutomatic(projectKey: string): Promise<void> {
    await this.enqueue(projectKey, async () => {
      const project = getProjectByKey(this.db, projectKey)
      if (!project) throw new Error('Project no longer exists')
      this.commitState(project, { version: 1, mode: 'auto', image: project.image || '' }, true)
      this.forget(projectKey)
    })
    await this.syncProject(projectKey)
  }

  private enqueue<T>(projectKey: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(projectKey) || Promise.resolve()
    const operation = previous.catch(() => {}).then(action)
    this.pending.set(projectKey, operation)
    const cleanup = (): void => {
      if (this.pending.get(projectKey) === operation) this.pending.delete(projectKey)
    }
    void operation.then(cleanup, cleanup)
    return operation
  }

  private async replace(
    projectKey: string,
    data: Uint8Array,
    mode: ProjectCoverMode
  ): Promise<string> {
    const project = getProjectByKey(this.db, projectKey)
    if (!project) throw new Error('Project no longer exists')
    const image = `project_${mode === 'custom' ? 'cover' : 'auto'}_${Date.now()}_${randomUUID().slice(0, 8)}.${mode === 'custom' ? 'jpg' : 'png'}`
    await mkdir(this.thumbnailsDirectory, { recursive: true })
    try {
      await writeFile(join(this.thumbnailsDirectory, image), data, { flag: 'wx' })
      this.commitState(project, { version: 1, mode, image }, mode === 'custom')
    } catch (error) {
      await this.removeUnreferencedImage(image)
      throw error
    }
    await this.removeUnreferencedImage(project.image)
    return image
  }

  /** Poll only registered projects; missing/offline screenshots leave the last good cover intact. */
  async sync(): Promise<void> {
    const projects = getAllProjects(this.db)
    const keys = new Set(projects.map((project) => project.projectKey))
    for (const key of new Set([...this.signatures.keys(), ...this.rejected.keys()])) {
      if (!keys.has(key)) this.forget(key)
    }
    await Promise.all(
      projects
        .filter((project) => !this.pending.has(project.projectKey))
        .map((project) => this.syncProject(project.projectKey))
    )
  }

  syncProject(projectKey: string): Promise<void> {
    return this.enqueue(projectKey, async () => {
      const project = getProjectByKey(this.db, projectKey)
      if (!project) return
      try {
        const saved = this.readState(this.statePath(project))
        const state = saved || {
          version: 1 as const,
          mode: projectCoverMode(project),
          image: project.image || ''
        }
        if (!saved || project.coverMode !== state.mode || (project.image || '') !== state.image) {
          this.commitState(project, state)
        }
        if (state.mode === 'auto' && project.projectPath) {
          await this.syncScreenshot(project, state)
        }
      } catch (error) {
        // A corrupt metadata record must not silently turn a custom cover into an automatic one.
        console.warn('[ProjectCover] Could not sync:', projectKey, error)
      }
    })
  }

  private forget(projectKey: string): void {
    this.signatures.delete(projectKey)
    this.rejected.delete(projectKey)
  }

  /** First existing candidate; only a missing file falls through, so a locked `<Name>.png` cannot flip the source. */
  private async findScreenshot(project: ProjectRecord): Promise<{ source: string; before: Stats }> {
    const candidates = projectThumbnailCandidates(project.projectPath!, project.originPath)
    for (const [index, source] of candidates.entries()) {
      try {
        return { source, before: await fs.stat(source) }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (index === candidates.length - 1 || (code !== 'ENOENT' && code !== 'ENOTDIR'))
          throw error
      }
    }
    throw new Error('No screenshot candidates')
  }

  private async syncScreenshot(project: ProjectRecord, state: CoverState): Promise<void> {
    const key = project.projectKey
    try {
      const { source, before } = await this.findScreenshot(project)
      const file = `${source}:${before.mtimeMs}:${before.ctimeMs}:${before.size}`
      if (this.signatures.get(key) === `${file}:${state.image}`) {
        try {
          await fs.access(join(this.thumbnailsDirectory, state.image))
          return
        } catch (error) {
          // An unchanged source still needs to rebuild a cache file removed outside the app.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (this.rejected.get(key) === file) return
      if (!before.isFile() || before.size === 0 || before.size > 32 * 1024 * 1024) return
      await this.withScreenshotSlot(async () => {
        const data = await fs.readFile(source)
        // Decode completely: a half-written PNG may have valid headers but no complete pixels.
        const sharp = await getSharp()
        try {
          await sharp(data, { failOn: 'warning', limitInputPixels: 16 * 1024 * 1024 })
            .raw()
            .toBuffer()
        } catch (error) {
          // A stable file that cannot be decoded would fail again; skip it until it changes.
          if (sameFile(before, await fs.stat(source))) this.rejected.set(key, file)
          throw error
        }
        this.rejected.delete(key)
        const after = await fs.stat(source)
        if (!sameFile(before, after)) return
        let current: Buffer | undefined
        if (state.image && !/[/\\:]/.test(state.image)) {
          try {
            current = await readFile(join(this.thumbnailsDirectory, state.image))
          } catch {
            /* Rebuild missing cache. */
          }
        }
        let image = state.image
        if (!current?.equals(data)) image = await this.replace(key, data, 'auto')
        this.signatures.set(key, `${file}:${image}`)
      })
    } catch {
      // Screenshot is missing, locked or still being written. Retry on the next scan.
      this.signatures.delete(key)
    }
  }

  private async withScreenshotSlot(operation: () => Promise<void>): Promise<void> {
    if (this.activeScreenshotReads >= MAX_CONCURRENT_SCREENSHOTS) {
      await new Promise<void>((resolve) => this.screenshotWaiters.push(resolve))
    } else {
      this.activeScreenshotReads++
    }
    try {
      await operation()
    } finally {
      const next = this.screenshotWaiters.shift()
      if (next) next()
      else this.activeScreenshotReads--
    }
  }

  private statePath(project: ProjectRecord): string {
    const identity = project.projectPath
      ? projectComparisonKeyWithoutFs(project.projectPath)
      : project.projectKey
    const name = createHash('sha256').update(identity).digest('hex')
    return join(this.thumbnailsDirectory, 'project-covers', `${name}.json`)
  }

  private readState(filePath: string): CoverState | null {
    const data = this.readStateFile(filePath)
    return data === null ? null : this.decodeState(data)
  }

  private readStateFile(filePath: string): Buffer | null {
    try {
      return readFileSync(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private decodeState(data: Buffer, recoverMalformed = false): CoverState | null {
    let state: unknown
    try {
      state = JSON.parse(data.toString('utf8'))
    } catch (error) {
      if (recoverMalformed && error instanceof SyntaxError) return null
      throw error
    }
    // Explicit user actions may replace corrupt records, but not downgrade an unknown format.
    if (state && typeof state === 'object' && 'version' in state && state.version !== 1) {
      throw new Error('Unsupported cover record version')
    }
    if (
      !state ||
      typeof state !== 'object' ||
      !('version' in state) ||
      state.version !== 1 ||
      !('mode' in state) ||
      (state.mode !== 'auto' && state.mode !== 'custom') ||
      !('image' in state) ||
      typeof state.image !== 'string'
    ) {
      if (recoverMalformed) return null
      throw new Error('Invalid cover record')
    }
    return { version: 1, mode: state.mode, image: state.image }
  }

  /** Persist the user's choice independently of SQLite; the database remains a rebuildable index. */
  private commitState(project: ProjectRecord, state: CoverState, recoverMalformed = false): void {
    const destination = this.statePath(project)
    // Keep the original bytes so even malformed/empty records can be restored after a DB failure.
    const previous = this.readStateFile(destination)
    if (previous !== null) this.decodeState(previous, recoverMalformed)
    mkdirSync(join(this.thumbnailsDirectory, 'project-covers'), { recursive: true })
    this.writeStateFile(destination, JSON.stringify(state))
    try {
      if (
        !updateProject(this.db, project.projectKey, { image: state.image, coverMode: state.mode })
      ) {
        throw new Error('Project no longer exists')
      }
    } catch (error) {
      if (previous !== null) this.writeStateFile(destination, previous)
      else unlinkSync(destination)
      throw error
    }
    this.notifyChanged()
  }

  private notifyChanged(): void {
    // A failed UI notification must not turn a completed write into a reported failure.
    try {
      this.onChanged()
    } catch (error) {
      console.warn('[ProjectCover] Notification failed:', error)
    }
  }

  private writeStateFile(destination: string, data: string | Uint8Array): void {
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, data, { flag: 'wx' })
      renameSync(temporary, destination)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        /* Renamed successfully. */
      }
    }
  }

  private async removeUnreferencedImage(image?: string | null): Promise<void> {
    // Protect both legacy index references and disk records not yet restored into the index.
    if (
      !image ||
      !/^(?:project_(?:cover|auto)_[\d]+_[\da-f]{8}\.(?:jpg|png)|thumbnail-[\da-f-]{36}\.[a-z]+)$/i.test(
        image
      )
    )
      return
    if (getAllProjects(this.db).some((project) => project.image === image)) return
    try {
      const recordsDirectory = join(this.thumbnailsDirectory, 'project-covers')
      let records: string[]
      try {
        records = readdirSync(recordsDirectory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        records = []
      }
      for (const record of records) {
        if (!record.endsWith('.json')) continue
        // An unreadable or corrupt record aborts cleanup, preserving potentially owned images.
        if (this.readState(join(recordsDirectory, record))?.image === image) return
      }
      await unlink(join(this.thumbnailsDirectory, image))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[ProjectCover] Could not remove unused image:', image, error)
      }
    }
  }
}

function sameFile(before: Stats, after: Stats): boolean {
  return (
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.size === after.size
  )
}
