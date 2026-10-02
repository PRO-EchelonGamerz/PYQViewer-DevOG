const { createClient } = require('@supabase/supabase-js');
const { getSession, parseBody, requireActiveTeacher } = require('../lib/auth');

module.exports = async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const body = parseBody(req);
    const session = getSession(req);
    const action = body.action || (req.method === 'GET' ? 'get_all' : 'insert');

    // ---- LIST (public) ----
    if (action === 'get_all') {
      const { data, error } = await supabase.from('worksheets').select('*').order('created_at', { ascending: false });
      if (error) return res.status(200).json({ success: false, error: error.message, worksheets: [] });
      let worksheets = data || [];
      if (body.subject_id) worksheets = worksheets.filter(w => w.subject_id === body.subject_id);
      return res.status(200).json({ success: true, worksheets });
    }

    // Everything below requires an approved, signed-in teacher whose session
    // hasn't been force-logged-out from the owner console.
    const check = await requireActiveTeacher(supabase, session);
    if (!check.ok) return res.status(200).json({ success: false, error: check.error });

    if (action === 'insert') {
      const title = (body.title || body.name || 'Untitled Worksheet').trim();
      const file_url = body.file_url || body.file || body.url;
      const file_path = body.file_path || null;
      const subject_id = body.subject_id || null;
      const sub_subject_id = body.sub_subject_id || null;

      if (!file_url) return res.status(200).json({ success: false, error: 'Missing file_url — the PDF must be uploaded to storage first.' });
      if (!subject_id) return res.status(200).json({ success: false, error: 'Missing subject.' });

      const newRecord = {
        id: 'ws_' + Date.now(),
        title, file_url, file_path, subject_id, sub_subject_id,
        teacher_id: session.id,
        teacher_name: session.name,
        created_at: new Date().toISOString(),
      };
      const { data, error } = await supabase.from('worksheets').insert([newRecord]).select();
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, data, worksheets: data });
    }

    if (action === 'delete') {
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing id.' });

      const { data: existing } = await supabase.from('worksheets').select('file_path,teacher_id').eq('id', id).maybeSingle();
      const canDelete = session.role === 'head' || session.role === 'owner' || (existing && existing.teacher_id === session.id);
      if (!canDelete) return res.status(200).json({ success: false, error: 'You can only delete your own uploads.' });

      const { error } = await supabase.from('worksheets').delete().eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      if (existing && existing.file_path) await supabase.storage.from('worksheets').remove([existing.file_path]);
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ success: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
};
