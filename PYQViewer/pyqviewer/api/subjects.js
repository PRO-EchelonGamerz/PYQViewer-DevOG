const { createClient } = require('@supabase/supabase-js');
const { getSession, parseBody, requireActiveTeacher } = require('../lib/auth');
const crypto = require('crypto');

module.exports = async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const body = parseBody(req);
    const session = getSession(req);

    // ---- Public: list approved subjects + their sub-subjects ----
    if (body.action === 'list' || !body.action) {
      const { data: subjects, error } = await supabase.from('subjects').select('*').eq('status', 'approved').order('name');
      if (error) return res.status(200).json({ success: false, error: error.message });
      const { data: subSubjects } = await supabase.from('sub_subjects').select('*').order('name');
      const grouped = (subjects || []).map(s => ({
        ...s,
        sub_subjects: (subSubjects || []).filter(ss => ss.subject_id === s.id),
      }));
      return res.status(200).json({ success: true, subjects: grouped });
    }

    // Everything below requires an approved teacher session that hasn't been
    // force-logged-out from the owner console since it was issued.
    const check = await requireActiveTeacher(supabase, session);
    if (!check.ok) return res.status(200).json({ success: false, error: check.error });

    if (body.action === 'create_subject') {
      const name = (body.name || '').trim();
      if (!name) return res.status(200).json({ success: false, error: 'Subject name required.' });
      const { data, error } = await supabase.from('subjects').insert([{
        id: 'sub_' + crypto.randomBytes(6).toString('hex'),
        name,
        created_by: session.id,
        created_by_name: session.name,
        status: 'pending', // needs another teacher to authenticate it
        created_at: new Date().toISOString(),
      }]).select().maybeSingle();
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, subject: data });
    }

    if (body.action === 'list_pending_subjects') {
      const { data, error } = await supabase.from('subjects').select('*').eq('status', 'pending').order('created_at', { ascending: false });
      if (error) return res.status(200).json({ success: false, error: error.message });
      // A teacher can't approve their own subject
      return res.status(200).json({ success: true, subjects: (data || []).filter(s => session.role === 'head' || s.created_by !== session.id) });
    }

    if (body.action === 'approve_subject') {
      const id = body.id;
      const { data: subj } = await supabase.from('subjects').select('created_by').eq('id', id).maybeSingle();
      if (subj && subj.created_by === session.id && session.role !== 'head') {
        return res.status(200).json({ success: false, error: 'You cannot authenticate your own subject — another teacher must do it.' });
      }
      const { error } = await supabase.from('subjects').update({ status: 'approved', approved_by: session.id }).eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'delete_pending_subject') {
      if (session.role !== 'head') return res.status(200).json({ success: false, error: 'Head access required.' });
      const id = body.id;
      const { data: subj } = await supabase.from('subjects').select('status').eq('id', id).maybeSingle();
      if (!subj) return res.status(200).json({ success: false, error: 'Subject not found.' });
      if (subj.status !== 'pending') return res.status(200).json({ success: false, error: 'Only pending subjects can be permanently deleted.' });
      const { error: subError } = await supabase.from('sub_subjects').delete().eq('subject_id', id);
      if (subError) return res.status(200).json({ success: false, error: subError.message });
      const { error } = await supabase.from('subjects').delete().eq('id', id).eq('status', 'pending');
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'deauthenticate_subject') {
      if (session.role !== 'head') return res.status(200).json({ success: false, error: 'Head access required.' });
      const id = body.id;
      const { error } = await supabase.from('subjects').update({ status: 'pending', approved_by: null }).eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    if (body.action === 'create_subsubject') {
      const name = (body.name || '').trim();
      const subjectId = body.subject_id;
      if (!name || !subjectId) return res.status(200).json({ success: false, error: 'Sub-subject name and parent subject required.' });
      const { data, error } = await supabase.from('sub_subjects').insert([{
        id: 'ssub_' + crypto.randomBytes(6).toString('hex'),
        subject_id: subjectId,
        name,
        created_by: session.id,
        created_by_name: session.name,
        created_at: new Date().toISOString(),
      }]).select().maybeSingle();
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true, sub_subject: data });
    }

    if (body.action === 'delete_subsubject') {
      // Head teachers and the creator can delete a sub-subject
      const id = body.id;
      if (!id) return res.status(200).json({ success: false, error: 'Missing sub-subject id.' });
      const { data: ss } = await supabase.from('sub_subjects').select('*').eq('id', id).maybeSingle();
      if (!ss) return res.status(200).json({ success: false, error: 'Sub-subject not found.' });
      if (session.role !== 'head' && ss.created_by !== session.id) {
        return res.status(200).json({ success: false, error: 'Only the creator or a head teacher can delete this sub-subject.' });
      }
      // Optionally move worksheets under this sub-subject to no sub-subject
      await supabase.from('worksheets').update({ sub_subject_id: null }).eq('sub_subject_id', id);
      const { error } = await supabase.from('sub_subjects').delete().eq('id', id);
      if (error) return res.status(200).json({ success: false, error: error.message });
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ success: false, error: 'Unknown action.' });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
};
