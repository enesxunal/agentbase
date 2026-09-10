ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute int NOT NULL DEFAULT 120 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  ADD COLUMN IF NOT EXISTS daily_quota int NOT NULL DEFAULT 10000 CHECK (daily_quota BETWEEN 1 AND 10000000),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE TABLE IF NOT EXISTS agent_api_usage (
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT current_date,
  request_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_active
  ON agent_tokens(agent_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_api_usage_date
  ON agent_api_usage(usage_date, request_count DESC);
