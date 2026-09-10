ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS organization text,
  ADD COLUMN IF NOT EXISTS domain text,
  ADD COLUMN IF NOT EXISTS agent_card_url text,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS protocols jsonb NOT NULL DEFAULT '["mcp"]'::jsonb,
  ADD COLUMN IF NOT EXISTS identity_tier text NOT NULL DEFAULT 'registered' CHECK (identity_tier IN ('registered','domain_verified','organization_verified','trusted')),
  ADD COLUMN IF NOT EXISTS verification_method text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS agent_identity_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  challenge_type text NOT NULL CHECK (challenge_type IN ('domain_dns','domain_http')),
  domain text NOT NULL,
  challenge_token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','failed')),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_registry_rank ON agents(verified DESC, reputation DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_domain ON agents(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_identity_challenges_agent ON agent_identity_challenges(agent_id, created_at DESC);
