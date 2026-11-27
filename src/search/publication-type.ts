const formats = {
  'journal-article': { ris: 'JOUR', bibtex: 'article', bibVenue: 'journal', zotero: 'journalArticle', zoteroVenue: 'publicationTitle' },
  'proceedings-article': { ris: 'CPAPER', bibtex: 'inproceedings', bibVenue: 'booktitle', zotero: 'conferencePaper', zoteroVenue: 'proceedingsTitle' },
  preprint: { ris: 'UNPB', bibtex: 'unpublished', bibVenue: 'note', zotero: 'preprint', zoteroVenue: 'repository' },
  book: { ris: 'BOOK', bibtex: 'book', bibVenue: 'publisher', zotero: 'book', zoteroVenue: 'publisher' },
  'book-chapter': { ris: 'CHAP', bibtex: 'incollection', bibVenue: 'booktitle', zotero: 'bookSection', zoteroVenue: 'bookTitle' },
  dataset: { ris: 'DATA', bibtex: 'misc', bibVenue: 'howpublished', zotero: 'dataset', zoteroVenue: 'repository' },
  thesis: { ris: 'THES', bibtex: 'phdthesis', bibVenue: 'school', zotero: 'thesis', zoteroVenue: 'university' },
  report: { ris: 'RPRT', bibtex: 'techreport', bibVenue: 'institution', zotero: 'report', zoteroVenue: 'institution' },
  unpublished: { ris: 'UNPB', bibtex: 'unpublished', bibVenue: 'note', zotero: 'manuscript', zoteroVenue: 'institution' },
  other: { ris: 'GEN', bibtex: 'misc', bibVenue: 'howpublished', zotero: 'document', zoteroVenue: 'publisher' },
} as const

export type PublicationType = keyof typeof formats

export function risPublicationType(rawType: string, subtype: string): PublicationType {
  const tag = rawType.trim().toUpperCase()
  if (tag === 'PREPRINT' || (tag === 'UNPB' && /pre[ -]?print/iu.test(subtype))) return 'preprint'
  if (['JOUR', 'JFULL', 'EJOUR', 'INPR'].includes(tag)) return 'journal-article'
  if (['CONF', 'CPAPER'].includes(tag)) return 'proceedings-article'
  return (Object.keys(formats) as PublicationType[]).find((type) =>
    type !== 'preprint' && formats[type].ris === tag,
  ) ?? 'other'
}

export function publicationFormat(rawType: string) {
  const type = rawType.trim().toLowerCase()
  if (Object.hasOwn(formats, type)) return formats[type as PublicationType]
  if (type.includes('review')) return formats['journal-article']
  if (/pre[ -]?print|arxiv|posted.content/u.test(type)) return formats.preprint
  if (/conference|proceedings/u.test(type)) return formats['proceedings-article']
  if (/chapter|book.section/u.test(type)) return formats['book-chapter']
  if (type.includes('book')) return formats.book
  if (type.includes('dataset')) return formats.dataset
  if (/thesis|dissertation/u.test(type)) return formats.thesis
  if (type.includes('report')) return formats.report
  return formats['journal-article']
}
