const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: rows } = await supabase.from('settings').select('key,value').in('key', ['maintenance_mode','customize_enabled','theme_reset_token','site_logo']);
    const map = {};
    (rows || []).forEach(r => { map[r.key] = r.value; });
    return res.status(200).json({
      success: true,
      maintenance: map.maintenance_mode === 'true',
      customize: map.customize_enabled !== 'false',
      theme_reset: map.theme_reset_token || null,
      logo: map.site_logo || null
    });
  } catch (err) {
    return res.status(200).json({ success: true, maintenance: false, customize: true });
  }
};
