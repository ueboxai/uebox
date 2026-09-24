import { getPublicDatabase } from '../../sqliteDataBase'
import { PathManager } from '../../utils/PathManager'
import { sendToAppWindows } from '../../appWindows'
import { ProjectCoverService } from './projectCovers'

let service: ProjectCoverService | undefined

export function getProjectCoverService(): ProjectCoverService {
  service ??= new ProjectCoverService(
    getPublicDatabase(),
    PathManager.getInstance().getPublicThumbnailsPath(),
    () => sendToAppWindows('db:project:library-changed')
  )
  return service
}

export async function stopProjectCoverSync(): Promise<void> {
  await service?.stop()
}
