// One adapter per source, in ARCHITECTURE.md §7 order of fit.
// Each adapter: { name, group_hint, index_urls, detail_match? }
// The runner fetches index pages, extracts JSON-LD there, and follows detail links when a
// detail_match is given. Selectors are deliberately absent: JSON-LD is the contract.

export const SOURCES = [
  {
    name: 'do512family',
    group_hint: 'kids',
    index_urls: ['https://family.do512.com/events/this-weekend', 'https://family.do512.com/events'],
    detail_match: /family\.do512\.com\/events\/\d{4}\//,
  },
  {
    name: 'alamo',
    group_hint: 'odd',
    index_urls: ['https://drafthouse.com/austin/tickets/calendar'],
    detail_match: /drafthouse\.com\/austin\/show\//,
  },
  {
    name: 'apl',
    group_hint: 'kids',
    index_urls: ['https://library.austintexas.gov/events'],
    detail_match: /library\.austintexas\.gov\/event\//,
  },
  { name: 'museum:blanton', group_hint: 'odd', index_urls: ['https://blantonmuseum.org/events/'] },
  { name: 'museum:bullock', group_hint: 'odd', index_urls: ['https://www.thestoryoftexas.com/visit/calendar'] },
  { name: 'museum:thinkery', group_hint: 'kids', index_urls: ['https://thinkeryaustin.org/calendar/'] },
  { name: 'museum:contemporary', group_hint: 'odd', index_urls: ['https://thecontemporaryaustin.org/events/'] },
  { name: 'kidsoutandabout', group_hint: 'kids', index_urls: ['https://austin.kidsoutandabout.com/calendar'] },
  { name: 'do512', group_hint: null, index_urls: ['https://do512.com/events/this-weekend'], detail_match: /do512\.com\/events\/\d{4}\// },
  { name: 'chronicle', group_hint: null, index_urls: ['https://www.austinchronicle.com/events/'], detail_match: /austinchronicle\.com\/events\/[a-z]/ },
];

export const byName = (n) => SOURCES.find((s) => s.name === n);
