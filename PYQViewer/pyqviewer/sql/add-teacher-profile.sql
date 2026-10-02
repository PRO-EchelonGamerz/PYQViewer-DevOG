-- PYQViewer: store the Google profile picture URL for teacher profiles
alter table teachers
add column if not exists picture_url text;

NOTIFY pgrst, 'reload schema';
