-- Turkey geography backbone: country, seven geographical regions, and all 81 provinces.
-- Province names and the 81-province administrative structure are grounded in the
-- T.C. Icisleri Bakanligi Valilikler ve Kaymakamliklar directory.

INSERT INTO sources (id, name, url, type, authority_score)
VALUES ('source_icisleri_valilikler', 'T.C. İçişleri Bakanlığı - Valilikler ve Kaymakamlıklar', 'https://www.icisleri.gov.tr/valilikler', 'official', 0.990)
ON CONFLICT (id) DO UPDATE SET name=excluded.name, url=excluded.url, type=excluded.type, authority_score=excluded.authority_score, retrieved_at=now();

INSERT INTO entities (id, slug, type, name, summary, location)
VALUES
 ('country_tr','turkiye','country','Türkiye','AgentBase Türkiye bilgi grafiğinin ülke kök varlığı.','{"country":"TR"}'::jsonb),
 ('region_marmara','marmara-bolgesi','region','Marmara Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb),
 ('region_ege','ege-bolgesi','region','Ege Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb),
 ('region_akdeniz','akdeniz-bolgesi','region','Akdeniz Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb),
 ('region_ic_anadolu','ic-anadolu-bolgesi','region','İç Anadolu Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb),
 ('region_karadeniz','karadeniz-bolgesi','region','Karadeniz Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb),
 ('region_dogu_anadolu','dogu-anadolu-bolgesi','region','Doğu Anadolu Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb),
 ('region_guneydogu_anadolu','guneydogu-anadolu-bolgesi','region','Güneydoğu Anadolu Bölgesi','Türkiye’nin yedi coğrafi bölgesinden biri.','{"country":"TR"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET name=excluded.name, type=excluded.type, location=excluded.location, updated_at=now();

WITH city_data(code, slug, name, region_id, region_name) AS (
 VALUES
 ('01','adana','Adana','region_akdeniz','Akdeniz Bölgesi'),
 ('02','adiyaman','Adıyaman','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('03','afyonkarahisar','Afyonkarahisar','region_ege','Ege Bölgesi'),
 ('04','agri','Ağrı','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('05','amasya','Amasya','region_karadeniz','Karadeniz Bölgesi'),
 ('06','ankara','Ankara','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('07','antalya','Antalya','region_akdeniz','Akdeniz Bölgesi'),
 ('08','artvin','Artvin','region_karadeniz','Karadeniz Bölgesi'),
 ('09','aydin','Aydın','region_ege','Ege Bölgesi'),
 ('10','balikesir','Balıkesir','region_marmara','Marmara Bölgesi'),
 ('11','bilecik','Bilecik','region_marmara','Marmara Bölgesi'),
 ('12','bingol','Bingöl','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('13','bitlis','Bitlis','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('14','bolu','Bolu','region_karadeniz','Karadeniz Bölgesi'),
 ('15','burdur','Burdur','region_akdeniz','Akdeniz Bölgesi'),
 ('16','bursa','Bursa','region_marmara','Marmara Bölgesi'),
 ('17','canakkale','Çanakkale','region_marmara','Marmara Bölgesi'),
 ('18','cankiri','Çankırı','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('19','corum','Çorum','region_karadeniz','Karadeniz Bölgesi'),
 ('20','denizli','Denizli','region_ege','Ege Bölgesi'),
 ('21','diyarbakir','Diyarbakır','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('22','edirne','Edirne','region_marmara','Marmara Bölgesi'),
 ('23','elazig','Elazığ','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('24','erzincan','Erzincan','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('25','erzurum','Erzurum','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('26','eskisehir','Eskişehir','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('27','gaziantep','Gaziantep','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('28','giresun','Giresun','region_karadeniz','Karadeniz Bölgesi'),
 ('29','gumushane','Gümüşhane','region_karadeniz','Karadeniz Bölgesi'),
 ('30','hakkari','Hakkâri','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('31','hatay','Hatay','region_akdeniz','Akdeniz Bölgesi'),
 ('32','isparta','Isparta','region_akdeniz','Akdeniz Bölgesi'),
 ('33','mersin','Mersin','region_akdeniz','Akdeniz Bölgesi'),
 ('34','istanbul','İstanbul','region_marmara','Marmara Bölgesi'),
 ('35','izmir','İzmir','region_ege','Ege Bölgesi'),
 ('36','kars','Kars','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('37','kastamonu','Kastamonu','region_karadeniz','Karadeniz Bölgesi'),
 ('38','kayseri','Kayseri','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('39','kirklareli','Kırklareli','region_marmara','Marmara Bölgesi'),
 ('40','kirsehir','Kırşehir','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('41','kocaeli','Kocaeli','region_marmara','Marmara Bölgesi'),
 ('42','konya','Konya','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('43','kutahya','Kütahya','region_ege','Ege Bölgesi'),
 ('44','malatya','Malatya','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('45','manisa','Manisa','region_ege','Ege Bölgesi'),
 ('46','kahramanmaras','Kahramanmaraş','region_akdeniz','Akdeniz Bölgesi'),
 ('47','mardin','Mardin','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('48','mugla','Muğla','region_ege','Ege Bölgesi'),
 ('49','mus','Muş','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('50','nevsehir','Nevşehir','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('51','nigde','Niğde','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('52','ordu','Ordu','region_karadeniz','Karadeniz Bölgesi'),
 ('53','rize','Rize','region_karadeniz','Karadeniz Bölgesi'),
 ('54','sakarya','Sakarya','region_marmara','Marmara Bölgesi'),
 ('55','samsun','Samsun','region_karadeniz','Karadeniz Bölgesi'),
 ('56','siirt','Siirt','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('57','sinop','Sinop','region_karadeniz','Karadeniz Bölgesi'),
 ('58','sivas','Sivas','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('59','tekirdag','Tekirdağ','region_marmara','Marmara Bölgesi'),
 ('60','tokat','Tokat','region_karadeniz','Karadeniz Bölgesi'),
 ('61','trabzon','Trabzon','region_karadeniz','Karadeniz Bölgesi'),
 ('62','tunceli','Tunceli','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('63','sanliurfa','Şanlıurfa','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('64','usak','Uşak','region_ege','Ege Bölgesi'),
 ('65','van','Van','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('66','yozgat','Yozgat','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('67','zonguldak','Zonguldak','region_karadeniz','Karadeniz Bölgesi'),
 ('68','aksaray','Aksaray','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('69','bayburt','Bayburt','region_karadeniz','Karadeniz Bölgesi'),
 ('70','karaman','Karaman','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('71','kirikkale','Kırıkkale','region_ic_anadolu','İç Anadolu Bölgesi'),
 ('72','batman','Batman','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('73','sirnak','Şırnak','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('74','bartin','Bartın','region_karadeniz','Karadeniz Bölgesi'),
 ('75','ardahan','Ardahan','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('76','igdir','Iğdır','region_dogu_anadolu','Doğu Anadolu Bölgesi'),
 ('77','yalova','Yalova','region_marmara','Marmara Bölgesi'),
 ('78','karabuk','Karabük','region_karadeniz','Karadeniz Bölgesi'),
 ('79','kilis','Kilis','region_guneydogu_anadolu','Güneydoğu Anadolu Bölgesi'),
 ('80','osmaniye','Osmaniye','region_akdeniz','Akdeniz Bölgesi'),
 ('81','duzce','Düzce','region_karadeniz','Karadeniz Bölgesi')
)
INSERT INTO entities (id, slug, type, name, summary, location)
SELECT 'city_'||slug, slug, 'city', name, name || ', Türkiye’de bir il ve şehir varlığıdır.', jsonb_build_object('city',name,'country','TR','region',region_name,'provinceCode',code)
FROM city_data
ON CONFLICT (id) DO UPDATE SET name=excluded.name, type='city', location=excluded.location, updated_at=now();

WITH city_data(code, slug, name, region_id) AS (
 VALUES
 ('01','adana','Adana','region_akdeniz'),('02','adiyaman','Adıyaman','region_guneydogu_anadolu'),('03','afyonkarahisar','Afyonkarahisar','region_ege'),('04','agri','Ağrı','region_dogu_anadolu'),('05','amasya','Amasya','region_karadeniz'),('06','ankara','Ankara','region_ic_anadolu'),('07','antalya','Antalya','region_akdeniz'),('08','artvin','Artvin','region_karadeniz'),('09','aydin','Aydın','region_ege'),('10','balikesir','Balıkesir','region_marmara'),('11','bilecik','Bilecik','region_marmara'),('12','bingol','Bingöl','region_dogu_anadolu'),('13','bitlis','Bitlis','region_dogu_anadolu'),('14','bolu','Bolu','region_karadeniz'),('15','burdur','Burdur','region_akdeniz'),('16','bursa','Bursa','region_marmara'),('17','canakkale','Çanakkale','region_marmara'),('18','cankiri','Çankırı','region_ic_anadolu'),('19','corum','Çorum','region_karadeniz'),('20','denizli','Denizli','region_ege'),('21','diyarbakir','Diyarbakır','region_guneydogu_anadolu'),('22','edirne','Edirne','region_marmara'),('23','elazig','Elazığ','region_dogu_anadolu'),('24','erzincan','Erzincan','region_dogu_anadolu'),('25','erzurum','Erzurum','region_dogu_anadolu'),('26','eskisehir','Eskişehir','region_ic_anadolu'),('27','gaziantep','Gaziantep','region_guneydogu_anadolu'),('28','giresun','Giresun','region_karadeniz'),('29','gumushane','Gümüşhane','region_karadeniz'),('30','hakkari','Hakkâri','region_dogu_anadolu'),('31','hatay','Hatay','region_akdeniz'),('32','isparta','Isparta','region_akdeniz'),('33','mersin','Mersin','region_akdeniz'),('34','istanbul','İstanbul','region_marmara'),('35','izmir','İzmir','region_ege'),('36','kars','Kars','region_dogu_anadolu'),('37','kastamonu','Kastamonu','region_karadeniz'),('38','kayseri','Kayseri','region_ic_anadolu'),('39','kirklareli','Kırklareli','region_marmara'),('40','kirsehir','Kırşehir','region_ic_anadolu'),('41','kocaeli','Kocaeli','region_marmara'),('42','konya','Konya','region_ic_anadolu'),('43','kutahya','Kütahya','region_ege'),('44','malatya','Malatya','region_dogu_anadolu'),('45','manisa','Manisa','region_ege'),('46','kahramanmaras','Kahramanmaraş','region_akdeniz'),('47','mardin','Mardin','region_guneydogu_anadolu'),('48','mugla','Muğla','region_ege'),('49','mus','Muş','region_dogu_anadolu'),('50','nevsehir','Nevşehir','region_ic_anadolu'),('51','nigde','Niğde','region_ic_anadolu'),('52','ordu','Ordu','region_karadeniz'),('53','rize','Rize','region_karadeniz'),('54','sakarya','Sakarya','region_marmara'),('55','samsun','Samsun','region_karadeniz'),('56','siirt','Siirt','region_guneydogu_anadolu'),('57','sinop','Sinop','region_karadeniz'),('58','sivas','Sivas','region_ic_anadolu'),('59','tekirdag','Tekirdağ','region_marmara'),('60','tokat','Tokat','region_karadeniz'),('61','trabzon','Trabzon','region_karadeniz'),('62','tunceli','Tunceli','region_dogu_anadolu'),('63','sanliurfa','Şanlıurfa','region_guneydogu_anadolu'),('64','usak','Uşak','region_ege'),('65','van','Van','region_dogu_anadolu'),('66','yozgat','Yozgat','region_ic_anadolu'),('67','zonguldak','Zonguldak','region_karadeniz'),('68','aksaray','Aksaray','region_ic_anadolu'),('69','bayburt','Bayburt','region_karadeniz'),('70','karaman','Karaman','region_ic_anadolu'),('71','kirikkale','Kırıkkale','region_ic_anadolu'),('72','batman','Batman','region_guneydogu_anadolu'),('73','sirnak','Şırnak','region_guneydogu_anadolu'),('74','bartin','Bartın','region_karadeniz'),('75','ardahan','Ardahan','region_dogu_anadolu'),('76','igdir','Iğdır','region_dogu_anadolu'),('77','yalova','Yalova','region_marmara'),('78','karabuk','Karabük','region_karadeniz'),('79','kilis','Kilis','region_guneydogu_anadolu'),('80','osmaniye','Osmaniye','region_akdeniz'),('81','duzce','Düzce','region_karadeniz')
)
INSERT INTO relations (id, subject_entity_id, predicate, object_entity_id, confidence)
SELECT 'rel_'||slug||'_country_tr', 'city_'||slug, 'located_in_country', 'country_tr', 1.0 FROM city_data
UNION ALL
SELECT 'rel_'||slug||'_region', 'city_'||slug, 'in_geographic_region', region_id, 0.99 FROM city_data
ON CONFLICT (id) DO NOTHING;

WITH city_data(code, slug) AS (
 VALUES
 ('01','adana'),('02','adiyaman'),('03','afyonkarahisar'),('04','agri'),('05','amasya'),('06','ankara'),('07','antalya'),('08','artvin'),('09','aydin'),('10','balikesir'),('11','bilecik'),('12','bingol'),('13','bitlis'),('14','bolu'),('15','burdur'),('16','bursa'),('17','canakkale'),('18','cankiri'),('19','corum'),('20','denizli'),('21','diyarbakir'),('22','edirne'),('23','elazig'),('24','erzincan'),('25','erzurum'),('26','eskisehir'),('27','gaziantep'),('28','giresun'),('29','gumushane'),('30','hakkari'),('31','hatay'),('32','isparta'),('33','mersin'),('34','istanbul'),('35','izmir'),('36','kars'),('37','kastamonu'),('38','kayseri'),('39','kirklareli'),('40','kirsehir'),('41','kocaeli'),('42','konya'),('43','kutahya'),('44','malatya'),('45','manisa'),('46','kahramanmaras'),('47','mardin'),('48','mugla'),('49','mus'),('50','nevsehir'),('51','nigde'),('52','ordu'),('53','rize'),('54','sakarya'),('55','samsun'),('56','siirt'),('57','sinop'),('58','sivas'),('59','tekirdag'),('60','tokat'),('61','trabzon'),('62','tunceli'),('63','sanliurfa'),('64','usak'),('65','van'),('66','yozgat'),('67','zonguldak'),('68','aksaray'),('69','bayburt'),('70','karaman'),('71','kirikkale'),('72','batman'),('73','sirnak'),('74','bartin'),('75','ardahan'),('76','igdir'),('77','yalova'),('78','karabuk'),('79','kilis'),('80','osmaniye'),('81','duzce')
)
INSERT INTO facts (id, subject_entity_id, predicate, value, confidence, status, version_group_id, version_no, is_current)
SELECT 'fact_'||slug||'_plate_code', 'city_'||slug, 'ab:vehiclePlateCode', to_jsonb(code), 1.0, 'verified', gen_random_uuid(), 1, true FROM city_data
ON CONFLICT (id) DO UPDATE SET value=excluded.value, confidence=excluded.confidence, status=excluded.status, last_checked=now(), is_current=true;

INSERT INTO fact_sources (fact_id, source_id, evidence)
SELECT id, 'source_icisleri_valilikler', 'Türkiye’nin 81 il yapısı ve il kimliği için resmi İçişleri Bakanlığı kaynağı.'
FROM facts WHERE id LIKE 'fact_%_plate_code'
ON CONFLICT (fact_id, source_id) DO NOTHING;
