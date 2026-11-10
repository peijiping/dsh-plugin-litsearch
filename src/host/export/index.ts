/** 导出格式分发：把同一个上下文渲染成 CSV / RIS / BibTeX / Markdown。 */

import type { ExportFile, ExportFormat } from '../../search/types.js'
import { renderBibtex } from './bibtex.js'
import type { ExportContext } from './common.js'
import { exportStem } from './common.js'

export type { ExportContext } from './common.js'
import { renderCsv } from './csv.js'
import { renderMarkdown } from './markdown.js'
import { renderRis } from './ris.js'

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  ris: 'application/x-research-info-systems; charset=utf-8',
  bibtex: 'application/x-bibtex; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
}

export function buildExport(context: ExportContext, format: ExportFormat): ExportFile {
  const stem = exportStem(context.task, context.generatedAt)
  switch (format) {
    case 'csv':
      return { filename: `${stem}.csv`, mime: MIME.csv, content: renderCsv(context) }
    case 'ris':
      return { filename: `${stem}.ris`, mime: MIME.ris, content: renderRis(context) }
    case 'bibtex':
      return { filename: `${stem}.bib`, mime: MIME.bibtex, content: renderBibtex(context) }
    default:
      return { filename: `${stem}.md`, mime: MIME.md, content: renderMarkdown(context) }
  }
}
