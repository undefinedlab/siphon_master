-- Create the dedicated Ponder indexer database on first postgres boot.
-- NOTE: '--' not '#'. psql treats '#' as a syntax error at character 1, which aborts the whole
-- script, so siphon_indexer is never created and the Ponder container crash-loops with
-- "database \"siphon_indexer\" does not exist".
CREATE DATABASE siphon_indexer;
GRANT ALL PRIVILEGES ON DATABASE siphon_indexer TO siphon;
-- Hard ASP association-set state and audit trail. The ASP container must not use local SQLite
-- in production because a replacement/restart would otherwise lose root history and decisions.
CREATE DATABASE siphon_asp;
GRANT ALL PRIVILEGES ON DATABASE siphon_asp TO siphon;
