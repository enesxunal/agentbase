CREATE TABLE IF NOT EXISTS agent_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'default',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS agent_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  entity_id text REFERENCES entities(id) ON DELETE CASCADE,
  contribution_type text NOT NULL,
  payload jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_contributions_status ON agent_contributions(status, created_at DESC);
