export {
  listFilesAction,
  makeDirectoryAction,
  moveEntryAction,
  readFileAction,
  removeEntryAction,
  writeFileAction,
} from './api/browse-files'
export { coversPath, rewriteMovedPath } from './lib/fs-path'
// Path → editor-language mapping — shared with the run workbench (widgets), so one table decides highlighting.
export { languageFor } from './lib/file-kind'
// The publication history of ONE path — the Files viewer's History tab, and the same panel under any surface
// whose content is really a workspace file (a skill's SKILL.md, a knowledge entry's body).
export { FileHistory } from './ui/file-history'
export { FileTreePane } from './ui/file-tree-pane'
export { FileViewer } from './ui/file-viewer'
export { FilesWorkbench } from './ui/files-workbench'
