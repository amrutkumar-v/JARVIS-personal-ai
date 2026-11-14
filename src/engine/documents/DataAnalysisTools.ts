/**
 * Deterministic Data Analysis & Chart Specification Tools (Mission Priority 5)
 *
 * Provides:
 *  - Statistical analysis: mean, median, stddev, variance, quartiles, IQR, min/max, outliers.
 *  - Trend detection: linear regression slope, R^2, percentage change, direction.
 *  - Chart generation: valid Chart.js and Vega-Lite structured specifications.
 */

import type { Tool, ToolCategory, ToolContextId, ToolInput, ToolPermission, ToolResult } from '../../tools/Tool'
import type { ToolInputSchema } from '../provider'
import type { DocumentStore } from './DocumentStore'
import type { TabularData } from './DocumentParser'

export interface NumericStats {
  count: number
  sum: number
  min: number
  max: number
  mean: number
  median: number
  stdDev: number
  variance: number
  q25: number
  q75: number
  iqr: number
  outliers: number[]
}

export interface TrendAnalysis {
  direction: 'increasing' | 'decreasing' | 'stable'
  slope: number
  rSquared: number
  percentageChange: number
  firstValue: number
  lastValue: number
}

export function computeNumericStats(rawValues: number[]): NumericStats | null {
  const vals = rawValues.filter((n) => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b)
  if (vals.length === 0) return null

  const count = vals.length
  const sum = vals.reduce((acc, v) => acc + v, 0)
  const mean = sum / count
  const min = vals[0]
  const max = vals[vals.length - 1]

  const median = count % 2 === 0 ? (vals[count / 2 - 1] + vals[count / 2]) / 2 : vals[Math.floor(count / 2)]

  // Quartiles
  const q25Index = Math.floor(count * 0.25)
  const q75Index = Math.floor(count * 0.75)
  const q25 = vals[q25Index]
  const q75 = vals[q75Index]
  const iqr = q75 - q25

  // Standard deviation & variance
  const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / count
  const stdDev = Math.sqrt(variance)

  // Outliers using 1.5 * IQR rule
  const lowerBound = q25 - 1.5 * iqr
  const upperBound = q75 + 1.5 * iqr
  const outliers = vals.filter((v) => v < lowerBound || v > upperBound)

  return {
    count,
    sum: Math.round(sum * 100) / 100,
    min,
    max,
    mean: Math.round(mean * 100) / 100,
    median: Math.round(median * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    variance: Math.round(variance * 100) / 100,
    q25,
    q75,
    iqr: Math.round(iqr * 100) / 100,
    outliers,
  }
}

export function detectTrend(values: number[]): TrendAnalysis | null {
  if (values.length < 2) return null

  const n = values.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  let sumYY = 0

  for (let i = 0; i < n; i++) {
    const x = i
    const y = values[i]
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
    sumYY += y * y
  }

  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0) return null

  const slope = (n * sumXY - sumX * sumY) / denominator

  // R^2
  const numeratorR = n * sumXY - sumX * sumY
  const denomR = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY))
  const r = denomR !== 0 ? numeratorR / denomR : 0
  const rSquared = Math.round(r * r * 1000) / 1000

  const first = values[0]
  const last = values[n - 1]
  const percentageChange = first !== 0 ? Math.round(((last - first) / Math.abs(first)) * 10000) / 100 : 0

  let direction: 'increasing' | 'decreasing' | 'stable' = 'stable'
  if (slope > 0.01) direction = 'increasing'
  else if (slope < -0.01) direction = 'decreasing'

  return {
    direction,
    slope: Math.round(slope * 1000) / 1000,
    rSquared,
    percentageChange,
    firstValue: first,
    lastValue: last,
  }
}

export interface CorrelationPair {
  colA: string
  colB: string
  coefficient: number
}

export interface GroupedAggregation {
  groupKey: string
  count: number
  aggregations: Record<string, number>
}

export interface DatasetProfile {
  totalRows: number
  totalColumns: number
  columnTypes: Record<string, string>
  missingValues: Record<string, number>
  numericSummaries: Record<string, NumericStats>
  correlationMatrix: CorrelationPair[]
}

/**
 * Computes Pearson correlation coefficient between two numeric vectors.
 */
export function computePearsonCorrelation(xVals: number[], yVals: number[]): number {
  const n = Math.min(xVals.length, yVals.length)
  if (n < 2) return 0

  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  let sumYY = 0

  for (let i = 0; i < n; i++) {
    const x = xVals[i]
    const y = yVals[i]
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
    sumYY += y * y
  }

  const denom = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY))
  if (denom === 0) return 0
  const r = (n * sumXY - sumX * sumY) / denom
  return Math.round(r * 1000) / 1000
}

/**
 * Computes pairwise Pearson correlation across all numeric columns in tabular data.
 */
export function computeCorrelationMatrix(tabular: TabularData): CorrelationPair[] {
  const numericCols = tabular.headers.filter(
    (h) => tabular.columnStats.find((s) => s.name === h)?.type === 'numeric',
  )
  const pairs: CorrelationPair[] = []

  for (let i = 0; i < numericCols.length; i++) {
    for (let j = i + 1; j < numericCols.length; j++) {
      const colA = numericCols[i]
      const colB = numericCols[j]
      const idxA = tabular.headers.indexOf(colA)
      const idxB = tabular.headers.indexOf(colB)

      const pairedVals = tabular.rows
        .map((r) => [Number(r[idxA]), Number(r[idxB])])
        .filter(([a, b]) => !Number.isNaN(a) && !Number.isNaN(b))

      const r = computePearsonCorrelation(
        pairedVals.map(([a]) => a),
        pairedVals.map(([, b]) => b),
      )
      pairs.push({ colA, colB, coefficient: r })
    }
  }

  return pairs
}

/**
 * Groups rows by a categorical column and aggregates target numeric values.
 */
export function aggregateByGroup(
  tabular: TabularData,
  groupCol: string,
  targetCol: string,
  func: 'sum' | 'avg' | 'count' | 'min' | 'max' = 'sum',
): GroupedAggregation[] {
  const groupIdx = tabular.headers.indexOf(groupCol)
  const targetIdx = tabular.headers.indexOf(targetCol)
  if (groupIdx === -1 || targetIdx === -1) return []

  const groups = new Map<string, number[]>()

  for (const row of tabular.rows) {
    const key = row[groupIdx] || 'Unknown'
    const val = Number(row[targetIdx])
    if (!Number.isNaN(val)) {
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(val)
    }
  }

  const results: GroupedAggregation[] = []
  for (const [key, vals] of groups.entries()) {
    let result = 0
    if (func === 'sum') result = vals.reduce((a, b) => a + b, 0)
    else if (func === 'avg') result = vals.reduce((a, b) => a + b, 0) / vals.length
    else if (func === 'count') result = vals.length
    else if (func === 'min') result = Math.min(...vals)
    else if (func === 'max') result = Math.max(...vals)

    const rounded = Math.round(result * 100) / 100
    results.push({
      groupKey: key,
      count: vals.length,
      aggregations: {
        [func]: rounded,
        [targetCol]: rounded,
      },
    })
  }

  return results
}

/**
 * Generates an exhaustive dataset profile with schema, statistics, and correlations.
 */
export function profileDataset(tabular: TabularData): DatasetProfile {
  const columnTypes: Record<string, string> = {}
  const missingValues: Record<string, number> = {}
  const numericSummaries: Record<string, NumericStats> = {}

  for (const col of tabular.columnStats) {
    columnTypes[col.name] = col.type
    const colIdx = tabular.headers.indexOf(col.name)
    const missingCount = tabular.rows.filter((r) => !r[colIdx] || r[colIdx].trim() === '').length
    missingValues[col.name] = missingCount

    if (col.type === 'numeric') {
      const vals = tabular.rows.map((r) => Number(r[colIdx])).filter((n) => !Number.isNaN(n))
      const stats = computeNumericStats(vals)
      if (stats) numericSummaries[col.name] = stats
    }
  }

  const correlationMatrix = computeCorrelationMatrix(tabular)

  return {
    totalRows: tabular.rowCount,
    totalColumns: tabular.headers.length,
    columnTypes,
    missingValues,
    numericSummaries,
    correlationMatrix,
  }
}

export function generateChartSpec(
  tabular: TabularData,
  options: {
    type?: 'bar' | 'line' | 'scatter' | 'pie' | 'histogram' | 'heatmap'
    labelColumn?: string
    valueColumns?: string[]
    title?: string
  } = {},
): { chartJs: Record<string, unknown>; vegaLite: Record<string, unknown> } {
  const chartType = options.type || 'bar'
  const headers = tabular.headers

  const labelCol =
    options.labelColumn ||
    headers.find((h) => tabular.columnStats.find((s) => s.name === h)?.type === 'string') ||
    headers[0] ||
    'Label'
  const labelIdx = headers.indexOf(labelCol)

  const valueCols =
    options.valueColumns && options.valueColumns.length > 0
      ? options.valueColumns
      : headers.filter((h) => h !== labelCol && tabular.columnStats.find((s) => s.name === h)?.type === 'numeric')

  const colors = [
    'rgba(59, 130, 246, 0.8)',
    'rgba(16, 185, 129, 0.8)',
    'rgba(245, 158, 11, 0.8)',
    'rgba(239, 68, 68, 0.8)',
    'rgba(139, 92, 246, 0.8)',
  ]

  let labels: string[] = []
  let datasets: Array<{
    label: string
    data: number[]
    backgroundColor: string | string[]
    borderColor: string | string[]
    borderWidth: number
  }> = []

  if (chartType === 'histogram' && valueCols.length > 0) {
    const targetCol = valueCols[0]
    const targetIdx = headers.indexOf(targetCol)
    const vals = tabular.rows.map((r) => Number(r[targetIdx])).filter((n) => !Number.isNaN(n))
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const binCount = Math.min(10, Math.max(5, Math.ceil(Math.sqrt(vals.length))))
    const binWidth = (max - min) / binCount || 1

    const binFreqs = new Array(binCount).fill(0)
    labels = []
    for (let b = 0; b < binCount; b++) {
      const bMin = Math.round((min + b * binWidth) * 10) / 10
      const bMax = Math.round((min + (b + 1) * binWidth) * 10) / 10
      labels.push(`${bMin} - ${bMax}`)
    }

    for (const v of vals) {
      let bIdx = Math.floor((v - min) / binWidth)
      if (bIdx >= binCount) bIdx = binCount - 1
      if (bIdx >= 0) binFreqs[bIdx]++
    }

    datasets = [
      {
        label: `Frequency of ${targetCol}`,
        data: binFreqs,
        backgroundColor: colors[0],
        borderColor: colors[0].replace('0.8', '1.0'),
        borderWidth: 1,
      },
    ]
  } else {
    labels = tabular.rows.map((r) => r[labelIdx] ?? '')
    datasets = valueCols.map((colName, idx) => {
      const colIdx = headers.indexOf(colName)
      const data = tabular.rows.map((r) => Number(r[colIdx]) || 0)
      return {
        label: colName,
        data,
        backgroundColor: chartType === 'pie' ? colors : colors[idx % colors.length],
        borderColor: chartType === 'pie' ? colors.map((c) => c.replace('0.8', '1.0')) : colors[idx % colors.length].replace('0.8', '1.0'),
        borderWidth: 1,
      }
    })
  }

  const chartJs = {
    type: chartType === 'histogram' ? 'bar' : chartType === 'heatmap' ? 'matrix' : chartType,
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: Boolean(options.title),
          text: options.title || '',
        },
      },
    },
  }

  // Vega-Lite specification
  const vegaDataValues = tabular.rows.map((r) => {
    const rowObj: Record<string, unknown> = {}
    rowObj[labelCol] = r[labelIdx]
    for (const vCol of valueCols) {
      const vIdx = headers.indexOf(vCol)
      rowObj[vCol] = Number(r[vIdx]) || 0
    }
    return rowObj
  })

  const vegaMark =
    chartType === 'pie'
      ? 'arc'
      : chartType === 'line'
        ? 'line'
        : chartType === 'scatter'
          ? 'point'
          : chartType === 'heatmap'
            ? 'rect'
            : 'bar'

  const vegaLite = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    description: options.title || `Chart of ${labelCol} vs ${valueCols.join(', ')}`,
    data: { values: vegaDataValues },
    mark: vegaMark,
    encoding: {
      x: chartType === 'histogram'
        ? { field: valueCols[0] || 'value', bin: true, type: 'quantitative' }
        : { field: labelCol, type: 'nominal' },
      y: chartType === 'histogram'
        ? { aggregate: 'count', type: 'quantitative' }
        : { field: valueCols[0] || 'value', type: 'quantitative' },
    },
  }

  return { chartJs, vegaLite }
}

export class DataAnalyzeTool implements Tool {
  readonly id = 'data.analyze'
  readonly name = 'Analyze structured data'
  readonly description = 'Performs statistical summarization, trend analysis, and anomaly detection on tabular columns.'
  readonly category: ToolCategory = 'info'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action to perform: stats, trend, correlation, group, or profile.' },
      documentId: { type: 'string', description: 'ID of an ingested tabular document.' },
      columnName: { type: 'string', description: 'Name of the numeric column to analyze.' },
      csvContent: { type: 'string', description: 'Optional raw CSV content to analyze inline.' },
      groupByColumn: { type: 'string', description: 'Column to group by when action is group.' },
      aggregateFunction: { type: 'string', description: 'Aggregation function for group action: sum, avg, count, min, or max.' },
    },
  }

  private readonly store: DocumentStore

  constructor(store: DocumentStore) {
    this.store = store
  }

  canRun(query: string): boolean {
    return /\b(analyze|statistics|stats|trend|average|mean|median|stddev|outliers|correlation|profile|group)\b/i.test(query) &&
      /\b(data|dataset|csv|column|metrics|sales|numbers|table)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const action = (input.params?.action as string | undefined)?.toLowerCase() || 'stats'
    const docId = input.params?.documentId as string | undefined
    const colName = input.params?.columnName as string | undefined
    const csvContent = input.params?.csvContent as string | undefined
    const groupByColumn = input.params?.groupByColumn as string | undefined
    const aggregateFunction = (input.params?.aggregateFunction as 'sum' | 'avg' | 'count' | 'min' | 'max' | undefined) || 'sum'

    let tabular: TabularData | undefined

    if (csvContent) {
      const parsed = this.store.ingest(csvContent, { fileName: 'inline.csv' })
      tabular = parsed.tabular
    } else if (docId) {
      tabular = this.store.getDocument(docId)?.tabular
    } else {
      const all = this.store.listDocuments()
      const lastTabular = all.reverse().find((d) => d.tabular)
      tabular = lastTabular?.tabular
    }

    if (!tabular || tabular.rowCount === 0) {
      return { ok: false, message: 'No tabular dataset found to analyze. Please ingest a CSV or table first.' }
    }

    if (action === 'profile') {
      const profile = profileDataset(tabular)
      const lines = [
        `### Dataset Profile Overview`,
        `- **Total Rows:** ${profile.totalRows}`,
        `- **Total Columns:** ${profile.totalColumns}`,
        '',
        `#### Column Schemas & Missingness:`,
      ]
      for (const [col, t] of Object.entries(profile.columnTypes)) {
        const missing = profile.missingValues[col] || 0
        lines.push(`- **${col}** (${t}) — Missing: ${missing}`)
      }
      if (profile.correlationMatrix.length > 0) {
        lines.push('', `#### Top Column Correlations:`)
        for (const c of profile.correlationMatrix.slice(0, 5)) {
          lines.push(`- ${c.colA} <-> ${c.colB}: **${c.coefficient}**`)
        }
      }
      return {
        ok: true,
        message: lines.join('\n'),
        data: profile,
      }
    }

    if (action === 'correlation') {
      const correlations = computeCorrelationMatrix(tabular)
      if (correlations.length === 0) {
        return { ok: false, message: 'Need at least 2 numeric columns to compute correlations.' }
      }
      const lines = [
        `### Pairwise Correlation Matrix`,
        `| Column A | Column B | Pearson Correlation (r) |`,
        `| :--- | :--- | :--- |`,
      ]
      for (const c of correlations) {
        lines.push(`| ${c.colA} | ${c.colB} | **${c.coefficient}** |`)
      }
      return {
        ok: true,
        message: lines.join('\n'),
        data: { correlations },
      }
    }

    if (action === 'group') {
      const headers = tabular.headers
      const groupCol = groupByColumn || headers.find((h) => tabular!.columnStats.find((s) => s.name === h)?.type === 'string') || headers[0]
      const targetCol = colName || headers.find((h) => h !== groupCol && tabular!.columnStats.find((s) => s.name === h)?.type === 'numeric') || headers[1]

      if (!headers.includes(groupCol)) {
        return { ok: false, message: `Grouping column "${groupCol}" not found. Available: ${headers.join(', ')}` }
      }
      if (!headers.includes(targetCol)) {
        return { ok: false, message: `Target column "${targetCol}" not found. Available: ${headers.join(', ')}` }
      }

      const grouped = aggregateByGroup(tabular, groupCol, targetCol, aggregateFunction)
      const lines = [
        `### Grouped Aggregation (${aggregateFunction.toUpperCase()} of "${targetCol}" grouped by "${groupCol}")`,
        `| ${groupCol} | Count | ${aggregateFunction.toUpperCase()}(${targetCol}) |`,
        `| :--- | :--- | :--- |`,
      ]
      for (const g of grouped) {
        lines.push(`| ${g.groupKey} | ${g.count} | **${g.aggregations[targetCol]}** |`)
      }
      return {
        ok: true,
        message: lines.join('\n'),
        data: { grouped, groupCol, targetCol, aggregateFunction },
      }
    }

    const headers = tabular.headers
    const targetCol = colName || headers.find((h) => tabular!.columnStats.find((s) => s.name === h)?.type === 'numeric') || headers[0]
    const colIdx = headers.indexOf(targetCol)

    if (colIdx === -1) {
      return { ok: false, message: `Column "${targetCol}" not found. Available columns: ${headers.join(', ')}` }
    }

    const rawVals = tabular.rows.map((r) => Number(r[colIdx])).filter((n) => !Number.isNaN(n))
    const stats = computeNumericStats(rawVals)
    const trend = detectTrend(rawVals)

    if (!stats) {
      return { ok: false, message: `Column "${targetCol}" contains no numeric values to analyze.` }
    }

    const outlierStr = stats.outliers.length > 0 ? stats.outliers.join(', ') : 'None detected'
    const trendStr = trend
      ? `Trend: **${trend.direction.toUpperCase()}** (Slope: ${trend.slope}, R²: ${trend.rSquared}, Overall Change: ${trend.percentageChange}%)`
      : 'Trend: Insufficient data points'

    const report = [
      `### Statistical Analysis for Column: **"${targetCol}"**`,
      '',
      `- **Data Points (N):** ${stats.count}`,
      `- **Sum:** ${stats.sum}`,
      `- **Mean (Average):** ${stats.mean}`,
      `- **Median:** ${stats.median}`,
      `- **Standard Deviation (σ):** ${stats.stdDev}`,
      `- **Variance (σ²):** ${stats.variance}`,
      `- **Min / Max:** ${stats.min} / ${stats.max}`,
      `- **Interquartile Range (IQR):** ${stats.iqr} (Q1: ${stats.q25}, Q3: ${stats.q75})`,
      `- **Statistical Outliers (1.5x IQR):** ${outlierStr}`,
      '',
      `### Trend & Progression`,
      `- ${trendStr}`,
    ].join('\n')

    return {
      ok: true,
      message: report,
      data: { stats, trend, column: targetCol },
    }
  }
}

export class DataChartTool implements Tool {
  readonly id = 'data.chart'
  readonly name = 'Generate chart specification'
  readonly description = 'Generates structured Chart.js and Vega-Lite specifications from tabular data.'
  readonly category: ToolCategory = 'info'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      documentId: { type: 'string', description: 'ID of an ingested tabular document.' },
      type: { type: 'string', description: 'Chart type: bar, line, scatter, pie, histogram, or heatmap.' },
      labelColumn: { type: 'string', description: 'Column to use for X-axis labels.' },
      valueColumns: { type: 'string', description: 'Comma-separated columns to plot as values.' },
      title: { type: 'string', description: 'Title of the chart.' },
    },
  }

  private readonly store: DocumentStore

  constructor(store: DocumentStore) {
    this.store = store
  }

  canRun(query: string): boolean {
    return /\b(plot|draw|generate|create)\s+(?:a\s+)?(?:chart|graph|histogram|scatter\s+plot|heatmap|bar\s+chart|line\s+chart)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const docId = input.params?.documentId as string | undefined
    const chartType = (input.params?.type as 'bar' | 'line' | 'scatter' | 'pie' | 'histogram' | 'heatmap') || 'bar'
    const labelColumn = input.params?.labelColumn as string | undefined
    const rawValCols = input.params?.valueColumns
    const valueColumns = typeof rawValCols === 'string'
      ? rawValCols.split(',').map((s) => s.trim())
      : Array.isArray(rawValCols)
        ? (rawValCols as string[])
        : undefined
    const title = input.params?.title as string | undefined

    let tabular: TabularData | undefined
    if (docId) {
      tabular = this.store.getDocument(docId)?.tabular
    } else {
      const all = this.store.listDocuments()
      const lastTabular = all.reverse().find((d) => d.tabular)
      tabular = lastTabular?.tabular
    }

    if (!tabular || tabular.rowCount === 0) {
      return { ok: false, message: 'No tabular dataset found to plot. Ingest a CSV first.' }
    }

    const { chartJs, vegaLite } = generateChartSpec(tabular, {
      type: chartType,
      labelColumn,
      valueColumns,
      title,
    })

    const summary = [
      `### Generated Chart Specification (${chartType.toUpperCase()})`,
      title ? `**Title:** ${title}` : '',
      `- **Data points:** ${tabular.rowCount}`,
      `- **Format:** Compatible with Chart.js and Vega-Lite renderers.`,
      '',
      '```json',
      JSON.stringify(chartJs, null, 2),
      '```',
    ].filter(Boolean).join('\n')

    return {
      ok: true,
      message: summary,
      data: { chartJs, vegaLite },
    }
  }
}
