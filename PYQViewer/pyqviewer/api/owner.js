const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { parseBody } = require('../lib/auth');

const OWNER_COOKIE = 'pyq_owner';
const SECRET = process.env.SESSION_SECRET;

// Credentials live ONLY as hashed environment variables set in Vercel —
// never in this file, never in the database, never visible to the head
// teacher account or any teacher account.
const OWNER_ACCOUNTS = [
  { user: process.env.OWNER1_USER, hash: process.env.OWNER1_HASH },
  { user: process.env.OWNER2_USER, hash: process.env.OWNER2_HASH },
].filter(a => a.user && a.hash);

function getOwnerSession(req) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(OWNER_COOKIE + '='));
  if (!match || !SECRET) return null;
  try { return jwt.verify(decodeURIComponent(match.split('=')[1]), SECRET); } catch (e) { return null; }
}

module.exports = async (req, res) => {
  try {
    const body = parseBody(req);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    if (body.action === 'login') {
      const { username, password } = body;
      const account = OWNER_ACCOUNTS.find(a => a.user === username);
      const ok = account ? await bcrypt.compare(String(password || ''), account.hash) : false;
      if (!ok) return res.status(200).json({ success: false, error: 'Invalid credentials.' });
      const token = jwt.sign({ role: 'owner', user: username }, SECRET, { expiresIn: '12h' });
      res.setHeader('Set-Cookie', `${OWNER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
      return res.status(200).json({ success: true });
    }

    const session = getOwnerSession(req);
    if (!session) return res.status(200).json({ success: false, error: 'Not authorized.' });

    if (body.action === 'logout') {
      res.setHeader('Set-Cookie', `${OWNER_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
      return res.status(200).json({ success: true });
    }

    if (body.action === 'status') {
      const { data } = await supabase.from('settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
      return res.status(200).json({ success: true, maintenance: data ? data.value === 'true' : false });
    }

    if (body.action === 'toggle_maintenance') {
      const on = body.on ? 'true' : 'false';
      const { error } = await supabase.from('settings').upsert({ key: 'maintenance_mode', value: on }, { onConflict: 'key' });
      if (error) return res.status(200).json({ success: false, error: 'Could not save: ' + error.message });
      // Read the row back rather than trusting the write — if this ever
      // silently no-ops again (bad onConflict target, RLS, etc.) the owner
      // console will show the real state instead of a false "success".
      const { data: verify, error: verifyErr } = await supabase.from('settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
      if (verifyErr || !verify || verify.value !== on) {
        return res.status(200).json({ success: false, error: 'Write did not persist — check that the settings table exists with (key text primary key, value text).' });
      }
      return res.status(200).json({ success: true, maintenance: verify.value === 'true' });
    }


    // Hide a login's location from the map without deleting the login record.
    // IP, teacher, event ID, timestamp and all other login information remain intact.
    if (body.action === 'hide_login_location') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing login event id.' });
      const { error } = await supabase
        .from('login_events')
        .update({ location_hidden: true })
        .eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    // Restore all locations that were hidden from the map.
    if (body.action === 'restore_map_locations') {
      const { error } = await supabase
        .from('login_events')
        .update({ location_hidden: false })
        .eq('location_hidden', true);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'purge_everything') {
      const { data: rows } = await supabase.from('worksheets').select('file_path');
      await supabase.from('worksheets').delete().neq('id', '');
      const paths = (rows || []).map(r => r.file_path).filter(Boolean);
      if (paths.length) await supabase.storage.from('worksheets').remove(paths);
      return res.status(200).json({ success: true });
    }

    // ---- Full site overview: every teacher, subject, worksheet, login event ----
    if (body.action === 'overview') {
      const { data: teachers } = await supabase.from('teachers').select('*').order('created_at', { ascending: false });
      const { data: worksheets } = await supabase.from('worksheets').select('*').order('created_at', { ascending: false });
      const { data: subjects } = await supabase.from('subjects').select('*').order('name');
      const { data: subSubjects } = await supabase.from('sub_subjects').select('*').order('name');
      const { data: events } = await supabase.from('login_events').select('*').order('created_at', { ascending: false }).limit(100);
      return res.status(200).json({
        success: true,
        teachers: teachers || [],
        worksheets: worksheets || [],
        subjects: subjects || [],
        sub_subjects: subSubjects || [],
        events: events || [],
      });
    }

    // ---- Owner has full head-teacher powers, from its own console, no
    // dependency on also holding a teacher session cookie ----

    if (body.action === 'approve_teacher' || body.action === 'reject_teacher') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing teacher id.' });
      if (body.action === 'approve_teacher') {
        const { error } = await supabase.from('teachers').update({ status: 'approved' }).eq('id', id);
        if (error) return res.status(200).json({ success: false, error: error.message });
      } else {
        const { error } = await supabase.from('teachers').delete().eq('id', id);
        if (error) return res.status(200).json({ success: false, error: error.message });
      }
      return res.status(200).json({ success: true });
    }

    if (body.action === 'set_teacher_role') {
      const id = body.id;
      const role = body.role;
      if (!id || !['teacher', 'head'].includes(role)) return res.status(200).json({ success: false, error: 'Missing/invalid id or role.' });
      const { error } = await supabase.from('teachers').update({ role }).eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    // ---- Force-logout: bump session_version so that teacher's existing
    // signed cookie stops being accepted the next time any endpoint checks it ----
    if (body.action === 'force_logout_teacher') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing teacher id.' });
      const { data: t } = await supabase.from('teachers').select('session_version').eq('id', id).maybeSingle();
      if (!t) return res.status(200).json({ success: false, error: 'Teacher not found.' });
      const { error } = await supabase.from('teachers').update({ session_version: (t.session_version || 0) + 1 }).eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'delete_teacher') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing teacher id.' });
      const { error } = await supabase.from('teachers').delete().eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'approve_subject' || body.action === 'deauthenticate_subject') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing subject id.' });
      const patch = body.action === 'approve_subject' ? { status: 'approved' } : { status: 'pending', approved_by: null };
      const { error } = await supabase.from('subjects').update(patch).eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'delete_subject') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing subject id.' });
      await supabase.from('sub_subjects').delete().eq('subject_id', id);
      const { error } = await supabase.from('subjects').delete().eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'delete_worksheet') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing worksheet id.' });
      const { data: existing } = await supabase.from('worksheets').select('file_path').eq('id', id).maybeSingle();
      const { error } = await supabase.from('worksheets').delete().eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      if (existing && existing.file_path) await supabase.storage.from('worksheets').remove([existing.file_path]);
      return res.status(200).json({ success: true });
    }

    // ---- Theme / customize controls (instant for all users via status poll) ----
    if (body.action === 'set_customize') {
      const on = body.on ? 'true' : 'false';
      await supabase.from('settings').upsert({ key: 'customize_enabled', value: on }, { onConflict: 'key' });
      return res.status(200).json({ success: true, customize: on === 'true' });
    }
    if (body.action === 'reset_themes') {
      // Bump a token; clients poll status and clear their localStorage theme when it changes
      const token = String(Date.now());
      await supabase.from('settings').upsert({ key: 'theme_reset_token', value: token }, { onConflict: 'key' });
      return res.status(200).json({ success: true, token });
    }
    if (body.action === 'set_logo') {
      const url = (body.url || '').trim();
      await supabase.from('settings').upsert({ key: 'site_logo', value: url || '' }, { onConflict: 'key' });
      return res.status(200).json({ success: true, logo: url || null });
    }

    // Create / rename subject or sub-subject as owner (attributed to a teacher)
    if (body.action === 'owner_create_subject') {
      const name = (body.name || '').trim();
      const teacherId = body.teacher_id || null;
      if (!name) return res.status(200).json({ success: false, error: 'Name required.' });
      const { data, error } = await supabase.from('subjects').insert([{
        id: 'sub_' + require('crypto').randomBytes(6).toString('hex'),
        name,
        created_by: teacherId,
        created_by_name: body.teacher_name || 'Owner',
        status: 'approved',
        created_at: new Date().toISOString(),
      }]).select().maybeSingle();
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, subject: data });
    }
    if (body.action === 'owner_create_subsubject') {
      const name = (body.name || '').trim();
      const subjectId = body.subject_id;
      if (!name || !subjectId) return res.status(200).json({ success: false, error: 'Name and subject required.' });
      const { data, error } = await supabase.from('sub_subjects').insert([{
        id: 'ssub_' + require('crypto').randomBytes(6).toString('hex'),
        subject_id: subjectId,
        name,
        created_by: body.teacher_id || null,
        created_by_name: body.teacher_name || 'Owner',
        created_at: new Date().toISOString(),
      }]).select().maybeSingle();
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, sub_subject: data });
    }
    if (body.action === 'owner_delete_subsubject') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing id.' });
      await supabase.from('worksheets').update({ sub_subject_id: null }).eq('sub_subject_id', id);
      const { error } = await supabase.from('sub_subjects').delete().eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }
    if (body.action === 'owner_rename') {
      const { type, id, name } = body;
      if (!type || !id || !name) return res.status(200).json({ success: false, error: 'type, id, name required.' });
      const table = type === 'subject' ? 'subjects' : type === 'subsubject' ? 'sub_subjects' : type === 'worksheet' ? 'worksheets' : null;
      if (!table) return res.status(200).json({ success: false, error: 'Invalid type.' });
      const { error } = await supabase.from(table).update({ name: name.trim() }).eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ success: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
};
