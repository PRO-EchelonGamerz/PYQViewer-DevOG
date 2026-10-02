-- PYQViewer: hide map pins without deleting login/audit records
alter table login_events
add column if not exists location_hidden boolean not null default false;

NOTIFY pgrst, 'reload schema';
