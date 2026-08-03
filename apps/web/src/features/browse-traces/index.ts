export { TraceBrowser, type TraceSelection } from './ui/trace-browser'
export { TraceDetail, TraceEventList } from './ui/trace-detail'
export { TrajectoryBrowser } from './ui/trajectory-browser'
// The sealed evidence's reading surface — shared by the settings trajectory dialog and the run detail.
// `asSingleSegment` is how a caller holding ONE stream (a legacy run's row embed) reads it here.
export { TrajectoryView } from './ui/trajectory-view'
export { asSingleSegment } from './lib/trajectory-planes'
export {
  getTrajectoryAction,
  listTrajectoriesAction,
  type ListTrajectoriesResult,
  type TrajectorySegment,
} from './api/browse-trajectories'
export {
  inspectTraceAction,
  listTracesAction,
  type InspectTraceResult,
  type ListTracesResult,
} from './api/browse-traces'
