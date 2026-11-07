-- A shared PDF's marks live in a document of their own, made on first use.
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check check (kind in ('markdown', 'latex', 'text', 'manifest', 'pdf'));
create index documents_pdf_file on documents (project_id, file_id) where kind = 'pdf';
