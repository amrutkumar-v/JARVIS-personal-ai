import { describe, expect, it } from 'vitest'
import {
  computeNumericStats,
  detectTrend,
  computePearsonCorrelation,
  computeCorrelationMatrix,
  aggregateByGroup,
  profileDataset,
  generateChartSpec,
  DataAnalyzeTool,
  DataChartTool,
} from './DataAnalysisTools'
import { DocumentStore } from './DocumentStore'

describe('DataAnalysisTools', () => {
  it('computes exact statistical metrics including mean, median, stddev, and outliers', () => {
    // Dataset: 10, 12, 14, 15, 16, 18, 20, 100 (100 is an outlier)
    const data = [10, 12, 14, 15, 16, 18, 20, 100]
    const stats = computeNumericStats(data)

    expect(stats).not.toBeNull()
    expect(stats!.count).toBe(8)
    expect(stats!.min).toBe(10)
    expect(stats!.max).toBe(100)
    expect(stats!.mean).toBe(25.63) // (205 / 8 = 25.625)
    expect(stats!.median).toBe(15.5) // (15 + 16) / 2
    expect(stats!.outliers).toContain(100)
  })

  it('detects linear trends and percentage changes', () => {
    // Strongly increasing: 10, 20, 30, 40, 50
    const increasing = [10, 20, 30, 40, 50]
    const trendInc = detectTrend(increasing)

    expect(trendInc).not.toBeNull()
    expect(trendInc!.direction).toBe('increasing')
    expect(trendInc!.slope).toBeGreaterThan(0)
    expect(trendInc!.percentageChange).toBe(400) // (50 - 10) / 10 = 400%
    expect(trendInc!.rSquared).toBe(1) // Perfect linear correlation

    // Strongly decreasing: 100, 80, 60, 40, 20
    const decreasing = [100, 80, 60, 40, 20]
    const trendDec = detectTrend(decreasing)

    expect(trendDec).not.toBeNull()
    expect(trendDec!.direction).toBe('decreasing')
    expect(trendDec!.slope).toBeLessThan(0)
  })

  it('generates valid Chart.js and Vega-Lite specifications', () => {
    const tabular = {
      headers: ['Month', 'Revenue', 'Cost'],
      rows: [
        ['Jan', '1000', '600'],
        ['Feb', '1200', '700'],
        ['Mar', '1500', '800'],
      ],
      rowCount: 3,
      columnStats: [
        { name: 'Month', type: 'string' as const, count: 3, uniqueCount: 3 },
        { name: 'Revenue', type: 'numeric' as const, count: 3, uniqueCount: 3, min: 1000, max: 1500, avg: 1233.33 },
        { name: 'Cost', type: 'numeric' as const, count: 3, uniqueCount: 3, min: 600, max: 800, avg: 700 },
      ],
    }

    const { chartJs, vegaLite } = generateChartSpec(tabular, {
      type: 'bar',
      labelColumn: 'Month',
      valueColumns: ['Revenue', 'Cost'],
      title: 'Q1 Financials',
    })

    expect(chartJs.type).toBe('bar')
    expect((chartJs.data as any).labels).toEqual(['Jan', 'Feb', 'Mar'])
    expect((chartJs.data as any).datasets).toHaveLength(2)
    expect((chartJs.data as any).datasets[0].label).toBe('Revenue')
    expect((chartJs.data as any).datasets[0].data).toEqual([1000, 1200, 1500])

    expect(vegaLite.$schema).toContain('vega-lite')
    expect(vegaLite.mark).toBe('bar')
  })

  it('runs DataAnalyzeTool via tool execution', async () => {
    const store = new DocumentStore()
    const tool = new DataAnalyzeTool(store)

    const csv = `Category,Sales,Growth\nA,100,10\nB,150,15\nC,200,20\nD,250,25\n`
    const res = await tool.execute({
      query: 'analyze sales',
      params: { csvContent: csv, columnName: 'Sales' },
    })

    expect(res.ok).toBe(true)
    expect(res.message).toContain('Statistical Analysis for Column: **"Sales"**')
    expect(res.message).toContain('**Mean (Average):** 175')
    expect(res.message).toContain('Trend: **INCREASING**')
  })

  it('runs DataChartTool via tool execution', async () => {
    const store = new DocumentStore()
    const parseRes = store.ingest(`Product,Stock\nWidgets,50\nGadgets,75\n`, { fileName: 'inventory.csv' })
    const tool = new DataChartTool(store)

    const res = await tool.execute({
      query: 'chart inventory',
      params: { documentId: parseRes.id, type: 'pie', title: 'Inventory Distribution' },
    })

    expect(res.ok).toBe(true)
    expect(res.message).toContain('Generated Chart Specification (PIE)')
    expect(res.message).toContain('Inventory Distribution')
  })

  it('computes Pearson correlation between two numeric series and correlation matrix', () => {
    const x = [1, 2, 3, 4, 5]
    const y = [2, 4, 6, 8, 10] // Perfect positive correlation
    const r = computePearsonCorrelation(x, y)
    expect(r).toBe(1)

    const yNeg = [10, 8, 6, 4, 2] // Perfect negative correlation
    const rNeg = computePearsonCorrelation(x, yNeg)
    expect(rNeg).toBe(-1)

    const tabular = {
      headers: ['X', 'Y', 'Z'],
      rows: [
        ['1', '2', '10'],
        ['2', '4', '8'],
        ['3', '6', '6'],
      ],
      rowCount: 3,
      columnStats: [
        { name: 'X', type: 'numeric' as const, count: 3, uniqueCount: 3 },
        { name: 'Y', type: 'numeric' as const, count: 3, uniqueCount: 3 },
        { name: 'Z', type: 'numeric' as const, count: 3, uniqueCount: 3 },
      ],
    }

    const matrix = computeCorrelationMatrix(tabular)
    expect(matrix.length).toBeGreaterThan(0)
    const xy = matrix.find((m) => (m.colA === 'X' && m.colB === 'Y') || (m.colA === 'Y' && m.colB === 'X'))
    expect(xy?.coefficient).toBe(1)
  })

  it('aggregates tabular data by group (sum, avg, count, min, max)', () => {
    const tabular = {
      headers: ['Dept', 'Salary'],
      rows: [
        ['Engineering', '100'],
        ['Engineering', '200'],
        ['Sales', '80'],
        ['Sales', '120'],
      ],
      rowCount: 4,
      columnStats: [
        { name: 'Dept', type: 'string' as const, count: 4, uniqueCount: 2 },
        { name: 'Salary', type: 'numeric' as const, count: 4, uniqueCount: 4 },
      ],
    }

    const sumRes = aggregateByGroup(tabular, 'Dept', 'Salary', 'sum')
    expect(sumRes).toEqual([
      { groupKey: 'Engineering', count: 2, aggregations: { sum: 300, Salary: 300 } },
      { groupKey: 'Sales', count: 2, aggregations: { sum: 200, Salary: 200 } },
    ])

    const avgRes = aggregateByGroup(tabular, 'Dept', 'Salary', 'avg')
    expect(avgRes).toEqual([
      { groupKey: 'Engineering', count: 2, aggregations: { avg: 150, Salary: 150 } },
      { groupKey: 'Sales', count: 2, aggregations: { avg: 100, Salary: 100 } },
    ])
  })

  it('profiles a dataset comprehensively', () => {
    const tabular = {
      headers: ['City', 'Population', 'Score'],
      rows: [
        ['Seattle', '750000', '88'],
        ['Portland', '650000', '82'],
        ['Vancouver', '', '90'],
      ],
      rowCount: 3,
      columnStats: [
        { name: 'City', type: 'string' as const, count: 3, uniqueCount: 3 },
        { name: 'Population', type: 'numeric' as const, count: 3, uniqueCount: 2 },
        { name: 'Score', type: 'numeric' as const, count: 3, uniqueCount: 3 },
      ],
    }

    const profile = profileDataset(tabular)
    expect(profile.totalRows).toBe(3)
    expect(profile.totalColumns).toBe(3)
    expect(profile.missingValues['Population']).toBe(1)
    expect(profile.numericSummaries['Score']).toBeDefined()
    expect(profile.numericSummaries['Score'].mean).toBe(86.67)
  })

  it('supports correlation, group, and profile actions in DataAnalyzeTool', async () => {
    const store = new DocumentStore()
    const tool = new DataAnalyzeTool(store)
    const csv = `Region,Sales,Profit\nEast,100,20\nEast,200,50\nWest,300,70\nWest,400,90\n`

    // Action: correlation
    const corrRes = await tool.execute({
      query: 'correlation',
      params: { csvContent: csv, action: 'correlation' },
    })
    expect(corrRes.ok).toBe(true)
    expect(corrRes.message).toContain('Pairwise Correlation Matrix')
    expect(corrRes.message).toContain('Sales')

    // Action: group
    const groupRes = await tool.execute({
      query: 'group sales by region',
      params: { csvContent: csv, action: 'group', groupByColumn: 'Region', columnName: 'Sales', aggregateFunction: 'sum' },
    })
    expect(groupRes.ok).toBe(true)
    expect(groupRes.message).toContain('Grouped Aggregation (SUM of "Sales" grouped by "Region")')
    expect(groupRes.message).toContain('East')
    expect(groupRes.message).toContain('300')

    // Action: profile
    const profRes = await tool.execute({
      query: 'profile data',
      params: { csvContent: csv, action: 'profile' },
    })
    expect(profRes.ok).toBe(true)
    expect(profRes.message).toContain('Dataset Profile Overview')
    expect(profRes.message).toContain('Total Rows:** 4')
  })

  it('generates histogram and heatmap chart specifications', () => {
    const tabular = {
      headers: ['Score'],
      rows: [['10'], ['15'], ['20'], ['25'], ['30'], ['35'], ['40'], ['45']],
      rowCount: 8,
      columnStats: [{ name: 'Score', type: 'numeric' as const, count: 8, uniqueCount: 8 }],
    }

    const hist = generateChartSpec(tabular, { type: 'histogram', valueColumns: ['Score'], title: 'Score Distribution' })
    expect(hist.chartJs.type).toBe('bar')
    expect(hist.vegaLite.mark).toBe('bar')
    expect((hist.vegaLite.encoding as any).x.bin).toBe(true)

    const heatmap = generateChartSpec(tabular, { type: 'heatmap', valueColumns: ['Score'] })
    expect(heatmap.chartJs.type).toBe('matrix')
    expect(heatmap.vegaLite.mark).toBe('rect')
  })
})
