# AgentBase Architecture v0.1

## 1. Sistem katmanları

1. Data ingestion
2. Knowledge core
3. Trust & provenance
4. Retrieval/search
5. Agent interface
6. Human web interface

## 2. Bilgi modeli

### Entity
Kalıcı kimliği olan nesne. Örn: şehir, işletme, mekan, yemek, kitap, etkinlik, agent.

### Fact
Bir entity hakkında atomik bilgi.

Örnek:
- subject: business_123
- predicate: opening_hours
- value: 09:00-18:00
- confidence: 0.98
- status: verified

### Relation
İki entity arasındaki bağlantı.

Örnek:
- Ankara -> located_in -> Türkiye
- Restoran X -> serves -> Çibörek

### Source
Fact veya relation'ın dayandığı kaynak.

### Provenance
Kaynağın nereden geldiği, ne zaman çekildiği, kim tarafından doğrulandığı ve ne kadar güvenilir olduğu.

## 3. Agent erişim katmanı

Planlanan erişimler:
- REST JSON API
- JSON-LD
- MCP
- A2A Agent Card uyumluluğu
- HTML + structured data
- sitemap.xml
- robots.txt
- llms.txt

## 4. V1 API yüzeyi

- POST /v1/search
- GET /v1/entities/:id
- GET /v1/entities/:id/facts
- GET /v1/entities/:id/relations
- GET /v1/entities/:id/sources
- GET /v1/changes
- POST /v1/ratings
- POST /v1/contributions

## 5. Güven modeli

Her önemli bilgi için mümkün olduğunca:
- source_type
- source_url
- retrieved_at
- last_checked_at
- confidence
- verification_status
- valid_from
- valid_to
- conflict_state

Fact durumları:
- true / confirmed
- false / disproven
- unknown
- conflicting

## 6. İlk teknik yaklaşım

- Web: Next.js
- API: TypeScript
- DB: PostgreSQL
- Geo: PostGIS
- Cache: Redis
- Search: başlangıçta PostgreSQL FTS; ihtiyaçta OpenSearch
- Event feed: başlangıçta PostgreSQL tabanlı; ölçeklenince Redpanda/Kafka
- Graph: başlangıçta relational model; ayrı graph DB yalnızca ihtiyaç oluşursa

## 7. Temel prensip

Tek veri kaydı, birden fazla çıktı:

Entity/Fact DB
-> HTML
-> JSON
-> JSON-LD
-> REST
-> MCP

İçerik farklı kanallar için ayrı ayrı tutulmamalı; hepsi aynı canonical veri katmanından üretilmeli.
