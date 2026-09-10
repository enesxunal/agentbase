-- Keep the IBB culture source focused on a rolling current/future event window.
-- The worker materializes start_date/end_date at run time from this metadata.
WITH target AS (
  UPDATE source_registry
  SET base_url='https://kultursanat.istanbul/etkinliklerimiz/ara',
      max_pages_per_run=35,
      metadata=metadata || '{"crawlProfile":"ibb-culture-events-current-v2","rollingDateWindowDays":45,"allowedPathPrefixes":["/etkinliklerimiz"],"allowedQueryKeys":["start_date","end_date","page","category_id","tag_id","venue_id"]}'::jsonb,
      updated_at=now()
  WHERE name='İBB Kültür Sanat'
  RETURNING id
)
DELETE FROM source_frontier f USING target t WHERE f.source_registry_id=t.id;
