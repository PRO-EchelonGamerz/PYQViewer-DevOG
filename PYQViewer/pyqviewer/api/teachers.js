const { createClient } = require('@supabase/supabase-js');
const { getSession, parseBody, requireActiveTeacher } = require('../lib/auth');

module.exports = async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const body = parseBody(req);
    const session = getSession(req);
    const check = await requireActiveTeacher(supabase, session);
    if (!check.ok) return res.status(200).json({ success: false, error: check.error });

    const isHead = session.role === 'head' || session.role === 'owner';

    // ---- Any signed-in teacher: see approved colleagues (no sensitive data — teachers have no passwords, they sign in with Google) ----
    if (body.action === 'list_colleagues') {
      const { data, error } = await supabase.from('teachers').select('id,name,role,created_at').eq('status', 'approved').order('name');
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, teachers: data || [] });
    }

    // ---- Head only: full directory with upload counts + last login info ----
    if (body.action === 'list_all') {
      if (!isHead) return res.status(200).json({ success: false, error: 'Only the head teacher can view this.' });
      const { data: teachers, error } = await supabase.from('teachers').select('id,name,email,role,status,created_at').order('created_at', { ascending: false });
      if (error) return res.status(200).json({ success: false, error: error.message });

      const { data: worksheets } = await supabase.from('worksheets').select('teacher_id');
      const counts = {};
      (worksheets || []).forEach(w => { if (w.teacher_id) counts[w.teacher_id] = (counts[w.teacher_id] || 0) + 1; });

      const enriched = (teachers || []).map(t => ({ ...t, upload_count: counts[t.id] || 0 }));
      return res.status(200).json({ success: true, teachers: enriched });
    }

    if (body.action === 'list_pending') {
      if (!isHead) return res.status(200).json({ success: false, error: 'Only the head teacher can view this.' });
      const { data, error } = await supabase.from('teachers').select('id,name,email,created_at').eq('status', 'pending').order('created_at', { ascending: false });
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, teachers: data || [] });
    }

    if (body.action === 'approve' || body.action === 'reject') {
      if (!isHead) return res.status(200).json({ success: false, error: 'Only the head teacher can do this.' });
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing teacher id.' });
      if (body.action === 'approve') {
        const { error } = await supabase.from('teachers').update({ status: 'approved' }).eq('id', id);
        if (error) return res.status(200).json({ success: false, error: error.message });
      } else {
        const { error } = await supabase.from('teachers').delete().eq('id', id);
        if (error) return res.status(200).json({ success: false, error: error.message });
      }
      return res.status(200).json({ success: true });
    }

    if (body.action === 'login_events') {
      // Precise IP/location has been moved to internal admin tooling; not
      // exposed to any teacher session, including the head teacher.
      return res.status(200).json({ success: false, error: 'This is no longer available here.' });
    }

    return res.status(200).json({ success: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
};
