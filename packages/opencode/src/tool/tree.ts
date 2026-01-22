import z from "zod"
import { Tool } from "./tool"
import * as path from "path"
import * as fs from "fs"
import DESCRIPTION from "./tree.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { IGNORE_PATTERNS } from "./ls"

const DEFAULT_DEPTH = Infinity
const DEFAULT_LIMIT = 1000

export const TreeTool = Tool.define("tree", {
  description: DESCRIPTION,
  parameters: z.object({
    path: z.string().describe("The path to display tree for (defaults to current directory)").optional(),
    depth: z.coerce.number().describe("Maximum depth to traverse (defaults to unlimited)").optional(),
    limit: z.coerce.number().describe("Maximum number of files to display (defaults to 1000)").optional(),
    filters: z.array(z.string()).describe("Regex patterns to filter files/directories").optional(),
  }),
  async execute(params, ctx) {
    const targetPath = path.resolve(Instance.directory, params.path || ".")
    await assertExternalDirectory(ctx, targetPath, { kind: "directory" })

    await ctx.ask({
      permission: "list",
      patterns: [targetPath],
      always: ["*"],
      metadata: { path: targetPath },
    })

    const maxDepth = params.depth ?? DEFAULT_DEPTH
    const maxFiles = params.limit ?? DEFAULT_LIMIT
    const filters = params.filters?.map((f) => new RegExp(f)) || []
    const ignoreSet = new Set(IGNORE_PATTERNS.map((p) => p.replace(/\/$/, "")))

    let fileCount = 0
    let truncated = false

    const shouldInclude = (name: string, fullPath: string): boolean => {
      if (ignoreSet.has(name)) return false
      if (filters.length === 0) return true
      return filters.some((regex) => regex.test(fullPath) || regex.test(name))
    }

    const buildTree = (dir: string, depth: number, prefix: string = ""): string[] => {
      if (depth > maxDepth || fileCount >= maxFiles) return []

      const lines: string[] = []
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const filtered = entries.filter((e) => shouldInclude(e.name, path.join(dir, e.name)))

      for (let idx = 0; idx < filtered.length; idx++) {
        if (fileCount >= maxFiles) {
          truncated = true
          break
        }

        const entry = filtered[idx]
        const isLast = idx === filtered.length - 1
        const connector = isLast ? "└── " : "├── "
        const extension = isLast ? "    " : "│   "
        const name = entry.isDirectory() ? `${entry.name}/` : entry.name

        lines.push(`${prefix}${connector}${name}`)
        fileCount++

        if (entry.isDirectory()) {
          const subDir = path.join(dir, entry.name)
          const subLines = buildTree(subDir, depth + 1, prefix + extension)
          lines.push(...subLines)
        }
      }

      return lines
    }

    const rootName = path.basename(targetPath)
    const tree = [`${rootName}/`, ...buildTree(targetPath, 0)]
    if (truncated) tree.push("", `(Truncated at ${maxFiles} files)`)
    const output = "```\n" + tree.join("\n") + "\n```"
    const preview = tree.slice(0, 20).join("\n")

    return {
      title: path.relative(Instance.worktree, targetPath),
      output,
      metadata: {
        preview,
        truncated,
        fileCount,
      },
    }
  },
})
