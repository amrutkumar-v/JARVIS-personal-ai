/**
 * Filesystem capability module (Phase 1.1) — safe, typed, verified filesystem
 * toolset. The in-memory provider used by tests lives in ./testing.ts and is
 * intentionally NOT exported here so production code can never bind to it.
 */
export * from './provider'
export { FS_LIMITS, boundedDepth, boundedLimit, clampedLength } from './limits'
export { normalizeSafePath, parentOf, baseNameOf, validateSegmentName, isRootPath } from './paths'
export {
  FileSystemAccessProvider,
  createFileSystemProvider,
} from './FileSystemAccessProvider'
export {
  createFileSystemTools,
  FileStatusTool,
  FileListTool,
  FileSearchTool,
  FileStatTool,
  FileReadTool,
  FileMkdirTool,
  FileWriteTool,
  FileCopyTool,
  FileMoveTool,
  FileRenameTool,
  FileDeleteTool,
} from './FileSystemTools'