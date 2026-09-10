import type { RichClaim } from './rich_extraction.js';

function clean(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string) {
  return clean(text)
    .split(/(?<=[.!?])\s+(?=[A-ZÇĞİÖŞÜ0-9])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 500)
    .slice(0, 1200);
}

function pushUnique(claims: RichClaim[], claim: RichClaim) {
  const key = `${claim.predicate}|${JSON.stringify(claim.value)}`;
  if (claims.some((item) => `${item.predicate}|${JSON.stringify(item.value)}` === key)) return;
  claims.push(claim);
}

export function extractSentenceClaims(input: {
  rawText: string;
  subjectName: string | null;
  subjectType?: string | null;
}) {
  const claims: RichClaim[] = [];
  const base = { subjectName: input.subjectName, subjectType: input.subjectType ?? null };

  for (const sentence of splitSentences(input.rawText)) {
    const normalized = sentence.toLocaleLowerCase('tr-TR');

    const hours = sentence.match(/\b(?:her\s+gün|pazartesi(?:den)?\s+cuma(?:ya)?|hafta\s+içi|hafta\s+sonu)?[^.]{0,80}?\b(\d{1,2}[.:]\d{2})\s*(?:-|–|—|ile|ve)\s*(\d{1,2}[.:]\d{2})\b[^.]{0,80}?\b(?:açık|açıktır|ziyaret|hizmet|faaliyet|kabul)\b/iu)
      ?? sentence.match(/\b(?:açık|açıktır|ziyaret|hizmet|faaliyet|kabul)[^.]{0,80}?\b(\d{1,2}[.:]\d{2})\s*(?:-|–|—|ile|ve)\s*(\d{1,2}[.:]\d{2})\b/iu);
    if (hours) {
      pushUnique(claims, {
        ...base,
        predicate: 'schema:openingHours',
        value: `${hours[1].replace('.', ':')} - ${hours[2].replace('.', ':')}`,
        confidence: 0.72,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const freeAdmission = /\b(?:giriş|ziyaret|müze|etkinlik)[^.]{0,100}?\b(?:ücretsiz|bedava|ücret alınmamaktadır|ücrete tabi değildir|ücret ödemez|ücret ödenmez)\b/iu.test(sentence) || /\b(?:ücretsiz|bedava)\b[^.]{0,80}?\b(?:giriş|ziyaret|müze|etkinlik)\b/iu.test(sentence);
    if (freeAdmission) {
      pushUnique(claims, {
        ...base,
        predicate: 'ab:admission',
        value: 'Ücretsiz',
        confidence: 0.7,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const admission = sentence.match(/\b(?:giriş|bilet|ziyaret)[^.]{0,60}?\b(?:ücreti|fiyatı|bedeli)?\s*(?:ise|:)??\s*(\d+(?:[.,]\d{1,2})?)\s*(TL|₺|TRY)\b/iu);
    if (admission && !freeAdmission) {
      pushUnique(claims, {
        ...base,
        predicate: 'ab:admission',
        value: `${admission[1]} ${admission[2].toUpperCase()}`,
        confidence: 0.71,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const founding = sentence.match(/\b((?:18|19|20)\d{2})\b[^.]{0,70}?\b(?:kuruldu|kurulmuştur|kuruluşu|açıldı|açılmıştır|hizmete girdi|faaliyete geçti)\b/iu)
      ?? sentence.match(/\b(?:kuruldu|kurulmuştur|kuruluşu|açıldı|açılmıştır|hizmete girdi|faaliyete geçti)\b[^.]{0,70}?\b((?:18|19|20)\d{2})\b/iu);
    if (founding) {
      pushUnique(claims, {
        ...base,
        predicate: 'schema:foundingDate',
        value: founding[1],
        confidence: 0.7,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const phone = sentence.match(/\b(?:telefon(?:dan)?|iletişim(?: için)?|arayabilirsiniz|numara(?:sı)?)[^.]{0,50}?((?:\+?90\s*)?(?:\(?0?\d{3}\)?[\s.-]*)?\d{3}[\s.-]*\d{2}[\s.-]*\d{2})\b/iu);
    if (phone) {
      pushUnique(claims, {
        ...base,
        predicate: 'schema:telephone',
        value: clean(phone[1]),
        confidence: 0.72,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const email = sentence.match(/\b(?:e-?posta|email|iletişim)[^.]{0,50}?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/iu);
    if (email) {
      pushUnique(claims, {
        ...base,
        predicate: 'schema:email',
        value: email[1],
        confidence: 0.78,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const outdoor = /\b(?:açık hava|bahçe|park|avlu|teras|doğa)\b/iu.test(sentence);
    const indoor = /\b(?:kapalı alan|iç mek[aâ]n|kapalı(?:\s+\w+){0,2}\s+salon\w*|sergi salon\w*|galeri salon\w*)\b/iu.test(sentence);
    const child = /\b(?:çocuklar|çocuklu aileler|aileler|çocuk dostu)\b/iu.test(sentence);
    if (child) {
      pushUnique(claims, {
        ...base,
        predicate: 'ab:familyFriendly',
        value: true,
        confidence: 0.62,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }
    if (indoor) {
      pushUnique(claims, {
        ...base,
        predicate: 'ab:indoor',
        value: true,
        confidence: 0.58,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }
    if (outdoor) {
      pushUnique(claims, {
        ...base,
        predicate: 'ab:outdoor',
        value: true,
        confidence: 0.58,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    const eventDate = sentence.match(/\b((?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:20\d{2}))\b[^.]{0,80}?\b(?:etkinlik|konser|sergi|festival|tiyatro|gerçekleşecek|düzenlenecek)\b/iu)
      ?? sentence.match(/\b(?:etkinlik|konser|sergi|festival|tiyatro|gerçekleşecek|düzenlenecek)\b[^.]{0,80}?\b((?:0?[1-9]|[12]\d|3[01])[./-](?:0?[1-9]|1[0-2])[./-](?:20\d{2}))\b/iu);
    if (eventDate) {
      const [day, month, year] = eventDate[1].split(/[./-]/).map(Number);
      const iso = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
      pushUnique(claims, {
        ...base,
        predicate: 'schema:startDate',
        value: iso,
        confidence: 0.66,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }

    if (normalized.includes('tekerlekli sandalye') || normalized.includes('engelli erişimine uygun') || normalized.includes('engelli erisimine uygun')) {
      pushUnique(claims, {
        ...base,
        predicate: 'ab:wheelchairAccessible',
        value: true,
        confidence: 0.66,
        evidence: `Sentence inference: ${sentence.slice(0, 240)}`
      });
    }
  }

  return claims.slice(0, 40);
}
