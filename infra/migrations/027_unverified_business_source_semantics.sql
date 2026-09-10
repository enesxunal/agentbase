UPDATE source_registry
SET source_type='public',
    authority_score=least(authority_score,0.65),
    name=regexp_replace(name, '^Business website: ', 'Discovered business source: '),
    metadata=metadata || '{"ownershipVerified":false,"sourceRole":"discovery-candidate"}'::jsonb,
    updated_at=now()
WHERE metadata->>'scope'='local-business'
  AND coalesce((metadata->>'ownershipVerified')::boolean,false)=false;
