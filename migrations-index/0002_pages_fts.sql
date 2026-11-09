-- Full-text search over brain_pages (FTS5, porter stemming).
--
-- brain_pages_fts is an external-content table: it stores only the search index and reads
-- text back through brain_pages_fts_source. The triggers keep it current, so every write
-- to brain_pages updates it in the same transaction and no code names it when writing.
-- A virtual table blocks `d1 export` for its database, which is why this lives in the
-- index database and never in the platform database.

CREATE VIEW brain_pages_fts_source AS
SELECT id,
       replace(replace(replace(path, '/', ' '), '-', ' '), '_', ' ') AS path_text,
       coalesce(title, '') AS title,
       content
FROM brain_pages;

CREATE VIRTUAL TABLE brain_pages_fts USING fts5(
  path_text, title, content,
  content = 'brain_pages_fts_source', content_rowid = 'id',
  tokenize = 'porter unicode61'
);

-- An external-content table forgets a row only when handed the values it indexed.
-- INSERT OR REPLACE removes the row it replaces without firing a DELETE trigger, so that
-- row is forgotten before the insert, while its old values can still be read.
CREATE TRIGGER brain_pages_fts_before_insert BEFORE INSERT ON brain_pages BEGIN
  INSERT INTO brain_pages_fts (brain_pages_fts, rowid, path_text, title, content)
  SELECT 'delete', id, replace(replace(replace(path, '/', ' '), '-', ' '), '_', ' '),
         coalesce(title, ''), content
  FROM brain_pages WHERE brain_id = new.brain_id AND path = new.path;
END;

CREATE TRIGGER brain_pages_fts_after_insert AFTER INSERT ON brain_pages BEGIN
  INSERT INTO brain_pages_fts (rowid, path_text, title, content)
  VALUES (new.id, replace(replace(replace(new.path, '/', ' '), '-', ' '), '_', ' '),
          coalesce(new.title, ''), new.content);
END;

CREATE TRIGGER brain_pages_fts_after_delete AFTER DELETE ON brain_pages BEGIN
  INSERT INTO brain_pages_fts (brain_pages_fts, rowid, path_text, title, content)
  VALUES ('delete', old.id, replace(replace(replace(old.path, '/', ' '), '-', ' '), '_', ' '),
          coalesce(old.title, ''), old.content);
END;

CREATE TRIGGER brain_pages_fts_after_update AFTER UPDATE ON brain_pages BEGIN
  INSERT INTO brain_pages_fts (brain_pages_fts, rowid, path_text, title, content)
  VALUES ('delete', old.id, replace(replace(replace(old.path, '/', ' '), '-', ' '), '_', ' '),
          coalesce(old.title, ''), old.content);
  INSERT INTO brain_pages_fts (rowid, path_text, title, content)
  VALUES (new.id, replace(replace(replace(new.path, '/', ' '), '-', ' '), '_', ' '),
          coalesce(new.title, ''), new.content);
END;

-- Index the rows already here.
INSERT INTO brain_pages_fts (brain_pages_fts) VALUES ('rebuild');
