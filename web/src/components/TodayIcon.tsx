const glyphs = {
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  plus: 'M12 5v14M5 12h14',
  chat: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l1.5-3A7.5 7.5 0 1 1 20 11.5Z M9 11.5h.01m3.49 0h.01m3.49 0h.01',
  history: 'M12 8v4l2.5 1.5M4.5 12a7.5 7.5 0 1 1 2 5.1M4.5 8v4h4',
  person: 'M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1',
  pulse: 'M2.5 12h4l2.1-5.5 4.1 11 2.7-7 1.5 1.5h4.6',
  rest: 'M9 7v10m6-10v10',
  sync: 'M20 10a8 8 0 0 0-13.7-4.1L4 8m0-4v4h4m-4 6a8 8 0 0 0 13.7 4.1L20 16m0 4v-4h-4',
  chevron: 'm9 6 6 6-6 6',
  route: 'M5 17h10a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6h5 M5 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm14-12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  check: 'm5 12 4 4 10-10',
  more: 'M5 12h.01m6.99 0h.01m6.99 0h.01',
  moon: 'M20 14.7A8.2 8.2 0 0 1 9.3 4 8.2 8.2 0 1 0 20 14.7Z',
  meal: 'M5 3v5a2 2 0 0 0 4 0V3M7 3v17m11 0V3c-2.5 2-3.5 5-3.5 8H18',
  note: 'M6 4h12v14H6zM9 8h6m-6 4h6',
}

export default function TodayIcon({ name, size = 20 }: { name: keyof typeof glyphs; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    <path d={glyphs[name]} />
  </svg>
}
