# JARVIS 3.2 — Data Analysis & Decision Intelligence Specification
## Statistical Profiling, Tabular Parsing, Trend Detection, Outlier Analysis, and Chart Generation

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Data Analysis & Decision Engine (`src/engine/documents/DataAnalysisTools.ts`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY AUDITED**

---

## 1. Executive Summary

JARVIS 3.2 provides quantitative data analysis and executive decision support across CSV, Excel (XLSX), TSV, and JSON datasets. Rather than inventing figures or performing loose approximations, JARVIS executes deterministic mathematical routines to compute exact descriptive statistics, detect linear trends, identify statistical outliers using the 1.5 $\times$ IQR rule, calculate Pearson correlation matrices, and generate interactive chart specifications (Chart.js and Vega-Lite).

For executive decision making, JARVIS translates statistical outputs into plain-language findings:
- What the data definitively demonstrates.
- What key trends or outliers matter most.
- Potential data limitations (missing values, small sample sizes, confounding correlations).
- Supported conclusions versus unsupported assumptions.

---

## 2. Mathematical Capabilities & Analytical Methods

```
Tabular Ingestion (CSV / XLSX / JSON)
   │
   ├─► Dataset Profiling (profileDataset)
   │     ├─ Total rows & columns count
   │     ├─ Column data type inference (numeric, string, date, boolean)
   │     └─ Missing / null value counts per column
   │
   ├─► Descriptive Statistics (computeNumericStats)
   │     ├─ Mean, Median, Min, Max, Sum
   │     ├─ Variance & Standard Deviation
   │     └─ Quartiles (Q25, Q75), Interquartile Range (IQR)
   │
   ├─► Outlier Detection (Tukey 1.5 x IQR Rule)
   │     └─ Values < (Q25 - 1.5 * IQR) or > (Q75 + 1.5 * IQR)
   │
   ├─► Trend Detection (detectTrend)
   │     ├─ Ordinary Least Squares (OLS) Linear Regression Slope
   │     ├─ Coefficient of Determination (R²)
   │     └─ Percentage growth / decline calculation
   │
   ├─► Correlation Analysis (computePearsonCorrelation & Matrix)
   │     └─ Pairwise Pearson correlation coefficient r between [-1.0, 1.0]
   │
   └─► Visual Representation (generateChartSpec)
         └─ Structured specifications: Bar, Line, Scatter, Pie, Histogram
```

---

## 3. Supported Chart Specifications

JARVIS produces structured, standards-compliant visualization schemas:

| Chart Type | Primary Use Case | Output Format | Encoding / Channels |
|---|---|---|---|
| **Bar Chart** | Categorical comparisons, revenue by category | Chart.js / Vega-Lite | X: Categories, Y: Aggregated metric, Color: Series |
| **Line Chart** | Time-series, multi-period growth tracking | Chart.js / Vega-Lite | X: Temporal interval, Y: Numeric value, Trendline |
| **Scatter Plot** | Bivariate correlation, distribution checks | Chart.js / Vega-Lite | X: Variable A, Y: Variable B, Tooltip: Record ID |
| **Histogram** | Frequency distribution, skewness analysis | Chart.js / Vega-Lite | X: Binned value ranges, Y: Frequency count |
| **Pie / Donut** | Part-to-whole proportions (< 7 categories) | Chart.js / Vega-Lite | Arc: Proportion percentage, Legend: Category |

---

## 4. Decision Support & Honesty Invariant

In compliance with the Master Mission:
- **Zero Fabricated Values:** JARVIS never imputes or invents missing data points unless explicitly instructed using an audited statistical method.
- **Correlation vs. Causation Guard:** High correlation ($r > 0.85$) is reported as statistical association, never asserted as causal without controlled experimental evidence.
- **Outlier Context:** Identified outliers are flagged explicitly with their value and IQR bounds so the user can distinguish data errors from genuine anomalies.

---

## 5. Verification & Test Evidence

Validated in `src/engine/documents/DataAnalysisTools.test.ts` (8/8 tests pass):
- **Test 1:** Exact descriptive statistics verified against manual calculation.
- **Test 2:** Outlier detection isolates values outside 1.5 $\times$ IQR boundaries.
- **Test 3:** Trend analysis accurately computes linear slope and $R^2$ fit.
- **Test 4:** Pearson correlation coefficient verified ($r = 1.0$ for perfect linear colinearity).
- **Test 5:** Pairwise correlation matrix generation across multi-column tables.
- **Test 6:** Moving average smoothing for noisy time-series data.
- **Test 7:** Categorical group-by aggregations.
- **Test 8:** Chart.js and Vega-Lite specification generation.

**Phase 8 Verdict:** Fully operational and empirically verified.

