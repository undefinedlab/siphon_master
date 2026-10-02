-- API gateway DB (packs / purchase / key verify). Created on first postgres boot only.
CREATE DATABASE siphon_gateway;
GRANT ALL PRIVILEGES ON DATABASE siphon_gateway TO siphon;
