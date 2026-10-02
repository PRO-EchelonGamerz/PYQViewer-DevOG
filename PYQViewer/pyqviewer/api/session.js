const { createClient } = require('@supabase/supabase-js');
const { getSession, clearSessionCookie, parseBody, requireActiveTeacher } = require('../lib/auth');

module.exports = async (req, res) => {
  try {
    const body = parseBody(req);

    if (body.action === 'logout') {
      clearSessionCookie(res);
      return res.status(200).json({ success: true });
    }

    const session = getSession(req);
    if (!session) return res.status(200).json({ success: true, loggedIn: false });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const check = await requireActiveTeacher(supabase, session);
    if (!check.ok) {
      clearSessionCookie(res);
      return res.status(200).json({ success: true, loggedIn: false });
    }

    const { session_version, ...teacher } = check.teacher;
    return res.status(200).json({ success: true, loggedIn: true, teacher });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
};
