// The app's chart system. Every plotted mark in the web comes from here, so a chart cannot invent its own
// palette, axis weight or tick rounding — see `palette.ts` for the color rules.
export { BarChart } from './bar-chart'
export { ChartEmpty, ChartLegend, ChartTooltip, TooltipRow } from './chart-frame'
export { LineChart } from './line-chart'
export {
  foldSeriesKeys,
  MAX_SERIES,
  OTHER_COLOR,
  SERIES_SLOTS,
  seriesColorAt,
  type ChartSeries,
} from './palette'
export { RankedBars, type RankedRow } from './ranked-bars'
