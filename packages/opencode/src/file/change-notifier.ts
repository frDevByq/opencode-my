import { Bus } from "@/bus"
import { FileWatcher } from "./watcher"
import { FileTime } from "./time"
import { FileIgnore } from "./ignore"
import { createTwoFilesPatch } from "diff"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import path from "path"
import ignore from "ignore"

const MAX_DIFF_LINES = 500

export namespace FileChangeNotifier {
  const log = Log.create({ service: "file.change-notifier" })

  interface PendingChange {
    filepath: string
    diff: string
    tooLarge: boolean
  }

  const state = Instance.state(() => {
    const snapshots = new Map<string, { content: string; sessions: Set<string> }>()
    const pending = new Map<string, PendingChange[]>()
    return { snapshots, pending }
  })

  export function init() {
    Bus.subscribe(FileWatcher.Event.Updated, async ({ properties }) => {
      const { file, event } = properties
      if (event !== "change") return

      const snapshot = state().snapshots.get(file)
      if (!snapshot) return

      const shouldIgnore = await isIgnored(file)
      if (shouldIgnore) {
        log.debug("ignoring change in ignored file", { file })
        return
      }

      const newContent = await Bun.file(file)
        .text()
        .catch(() => null)
      if (!newContent || newContent === snapshot.content) return

      const diff = createTwoFilesPatch(file, file, snapshot.content, newContent)
      const diffLines = diff.split("\n").length
      const tooLarge = diffLines > MAX_DIFF_LINES

      if (tooLarge) {
        log.info("external change too large", { file, diffLines })
      }

      for (const sessionID of snapshot.sessions) {
        const changes = state().pending.get(sessionID) || []
        changes.push({ filepath: file, diff: tooLarge ? "" : diff, tooLarge })
        state().pending.set(sessionID, changes)
      }

      snapshot.content = newContent
      log.info("external change detected", { file, sessions: snapshot.sessions.size })
    })
  }

  export function trackFile(sessionID: string, filepath: string, content: string) {
    const current = state().snapshots.get(filepath)
    if (current) {
      current.sessions.add(sessionID)
      current.content = content
    } else {
      state().snapshots.set(filepath, {
        content,
        sessions: new Set([sessionID]),
      })
    }
  }

  export function getPendingChanges(sessionID: string): PendingChange[] {
    const changes = state().pending.get(sessionID) || []
    state().pending.delete(sessionID)

    for (const change of changes) {
      FileTime.read(sessionID, change.filepath)
    }

    return changes
  }

  async function isIgnored(filepath: string): Promise<boolean> {
    const relative = path.relative(Instance.directory, filepath)

    if (FileIgnore.match(relative)) return true

    const gitignorePath = path.join(Instance.worktree, ".gitignore")
    const gitignoreFile = Bun.file(gitignorePath)
    if (await gitignoreFile.exists()) {
      const ig = ignore()
      ig.add(await gitignoreFile.text())
      if (ig.ignores(relative)) return true
    }

    const ignorePath = path.join(Instance.worktree, ".ignore")
    const ignoreFile = Bun.file(ignorePath)
    if (await ignoreFile.exists()) {
      const ig = ignore()
      ig.add(await ignoreFile.text())
      if (ig.ignores(relative)) return true
    }

    return false
  }
}
