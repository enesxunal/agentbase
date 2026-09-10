INSERT INTO entities (id, slug, type, name, summary, location)
VALUES
  ('city_ankara', 'ankara', 'city', 'Ankara', 'Türkiye''nin başkenti; tarih, müzeler, kamusal alanlar ve şehir yaşamı için önemli bir merkez.', '{"city":"Ankara","country":"TR"}'::jsonb),
  ('food_ciborek', 'ciborek', 'food', 'Çibörek', 'Eskişehir ile güçlü biçimde özdeşleşen, ince hamur ve kıymalı içle hazırlanan geleneksel yemek.', '{"city":"Eskişehir","country":"TR"}'::jsonb),
  ('place_anitkabir', 'anitkabir', 'place', 'Anıtkabir', 'Mustafa Kemal Atatürk''ün anıt mezarı ve Ankara''nın en önemli tarihi ziyaret noktalarından biri.', '{"city":"Ankara","country":"TR"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sources (id, name, url, type, authority_score)
VALUES
  ('source_official_ankara', 'Ankara Büyükşehir Belediyesi', 'https://www.ankara.bel.tr/', 'official', 0.950),
  ('source_official_eskisehir', 'Eskişehir Büyükşehir Belediyesi', 'https://www.eskisehir.bel.tr/', 'official', 0.950),
  ('source_anitkabir_official', 'Anıtkabir resmi kaynağı', 'https://www.anitkabir.tsk.tr/', 'official', 0.990)
ON CONFLICT (id) DO NOTHING;

INSERT INTO facts (id, subject_entity_id, predicate, value, confidence, status)
VALUES
  ('fact_ankara_country', 'city_ankara', 'country', '"Türkiye"'::jsonb, 1.000, 'verified'),
  ('fact_ankara_recommended_for', 'city_ankara', 'recommended_for', '["tarih","müze","şehir gezisi"]'::jsonb, 0.900, 'observed'),
  ('fact_ciborek_city', 'food_ciborek', 'associated_city', '"Eskişehir"'::jsonb, 0.960, 'verified'),
  ('fact_anitkabir_city', 'place_anitkabir', 'located_in', '"Ankara"'::jsonb, 1.000, 'verified')
ON CONFLICT (id) DO NOTHING;

INSERT INTO fact_sources (fact_id, source_id, evidence)
VALUES
  ('fact_ankara_country', 'source_official_ankara', 'Resmi şehir kaynağı'),
  ('fact_ankara_recommended_for', 'source_official_ankara', 'Şehir ve ziyaret içerikleri'),
  ('fact_ciborek_city', 'source_official_eskisehir', 'Yerel kültür/yemek içeriği'),
  ('fact_anitkabir_city', 'source_anitkabir_official', 'Resmi Anıtkabir kaynağı')
ON CONFLICT (fact_id, source_id) DO NOTHING;

INSERT INTO relations (id, subject_entity_id, predicate, object_entity_id, confidence)
VALUES
  ('rel_anitkabir_ankara', 'place_anitkabir', 'located_in', 'city_ankara', 1.000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agents (id, name, developer, website, description, verified, reputation)
VALUES
  ('agentbase-verifier', 'AgentBase Verifier', 'AgentBase', 'https://agentbase.com.tr', 'Kaynak ve güncellik doğrulama agent''ı', true, 98.00),
  ('travel-scout-tr', 'Travel Scout TR', 'AgentBase Labs', 'https://agentbase.com.tr', 'Türkiye içi yer ve gezi verilerini keşfeden demo agent.', true, 91.00)
ON CONFLICT (id) DO NOTHING;

INSERT INTO agent_events (agent_id, event_type, entity_id, payload, public)
VALUES
  ('agentbase-verifier', 'entity_verified', 'city_ankara', '{"message":"Ankara şehir kaydı doğrulandı"}'::jsonb, true),
  ('travel-scout-tr', 'entity_retrieved', 'place_anitkabir', '{"message":"Anıtkabir verisi alındı"}'::jsonb, true);
