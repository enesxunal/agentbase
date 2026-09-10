export type QueryIntent = {
  raw: string;
  normalized: string;
  tokens: string[];
  city?: string;
  typeHints: string[];
  facets: string[];
  intent: 'discover' | 'lookup' | 'recommend' | 'compare' | 'unknown';
};

const STOPWORDS = new Set([
  'bir','ve','ile','icin','için','mi','mı','mu','mü','ne','nerede','neresi','nereye','nasıl','nasil',
  'en','iyi','guzel','güzel','olan','olarak','var','mi','da','de','ki','ya','veya','bana','bize','ben','biz'
]);

const FACETS: Array<[string, string[]]> = [
  ['family_friendly', ['cocuk','çocuk','cocukla','çocukla','aile','family']],
  ['indoor', ['kapali','kapalı','iceride','içeride','indoor','yagmurlu','yağmurlu','yagmur','yağmur']],
  ['outdoor', ['acik hava','açık hava','outdoor','park','bahce','bahçe']],
  ['history', ['tarih','tarihi','muze','müze','antik','anıt','anit']],
  ['food', ['yemek','restoran','restaurant','kahvalti','kahvaltı','makarna','tatli','tatlı','kahve']],
  ['budget', ['ucuz','uygun fiyat','ekonomik','butce','bütçe']],
  ['premium', ['lüks','luxury','premium','fine dining']],
  ['accessible', ['engelli','erisilebilir','erişilebilir','wheelchair']],
  ['open_now', ['acik','açık','simdi','şimdi','su an','şu an']],
  ['event', ['etkinlik','konser','festival','sergi','tiyatro']]
];

const TYPE_HINTS: Array<[string, string[]]> = [
  ['business', ['restoran','restaurant','kafe','cafe','magaza','mağaza','isletme','işletme','otel','hotel']],
  ['place', ['gezilecek','yer','muze','müze','park','anıt','anit','mekan','mekân']],
  ['food', ['yemek','tat','mutfak','yoresel','yöresel']],
  ['event', ['etkinlik','konser','festival','sergi','tiyatro']],
  ['city', ['sehir','şehir','il','kent']]
];

export function normalizeQuery(value: string) {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseQuery(raw: string, knownCities: string[] = []): QueryIntent {
  const normalized = normalizeQuery(raw);
  const padded = ` ${normalized} `;
  const tokens = normalized.split(' ').filter(Boolean).filter((t) => !STOPWORDS.has(t));
  const facets = FACETS.filter(([, terms]) => terms.some((term) => padded.includes(` ${normalizeQuery(term)} `) || normalized.includes(normalizeQuery(term)))).map(([name]) => name);
  const typeHints = TYPE_HINTS.filter(([, terms]) => terms.some((term) => normalized.includes(normalizeQuery(term)))).map(([name]) => name);
  const city = knownCities.find((candidate) => normalized.includes(normalizeQuery(candidate)));

  let intent: QueryIntent['intent'] = 'unknown';
  if (/\b(oner|öner|tavsiye|en iyi|nereye|nerede|gezilecek)\b/i.test(raw)) intent = 'recommend';
  else if (/\b(karsilastir|karşılaştır|versus| vs |hangisi)\b/i.test(raw)) intent = 'compare';
  else if (/\b(nedir|kimdir|hakkinda|hakkında|bilgi)\b/i.test(raw)) intent = 'lookup';
  else if (tokens.length) intent = 'discover';

  return { raw, normalized, tokens, city, typeHints: [...new Set(typeHints)], facets: [...new Set(facets)], intent };
}

export function facetTerms(facet: string) {
  const row = FACETS.find(([name]) => name === facet);
  return row ? row[1].map(normalizeQuery) : [];
}
