const { createClient } = require('@supabase/supabase-js');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');
const {
  signSession, setSessionCookie, parseBody,
  getClientIp, lookupGeo, parseDevice,
} = require('../lib/auth');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const HEAD_TEACHER_EMAIL = (process.env.HEAD_TEACHER_EMAIL || '').toLowerCase();

module.exports = async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const body = parseBody(req);
    const credential = body.credential;
    const deviceLocation = body.deviceLocation || null;
    if (!credential) return res.status(200).json({ success: false, error: 'Missing Google credential.' });
    if (!GOOGLE_CLIENT_ID) return res.status(200).json({ success: false, error: 'Server is missing GOOGLE_CLIENT_ID.' });

    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || !payload.email_verified) {
      return res.status(200).json({ success: false, error: 'Google account email is not verified.' });
    }
    const email = String(payload.email).toLowerCase();
    if (!email.endsWith('@gmail.com')) {
      return res.status(200).json({ success: false, error: 'Please register with a Gmail address.' });
    }
    const googleSub = payload.sub;
    const displayName = payload.name || email.split('@')[0];
    const pictureUrl = typeof payload.picture === 'string' && /^https:\/\//i.test(payload.picture) ? payload.picture : null;

    // Find existing teacher by google_sub or email
    let { data: existing } = await supabase.from('teachers').select('*').or(`google_sub.eq.${googleSub},email.eq.${email}`).maybeSingle();

    let teacher = existing;
    if (!teacher) {
      const isHead = email === HEAD_TEACHER_EMAIL && HEAD_TEACHER_EMAIL.length > 0;
      const newTeacher = {
        id: 'tch_' + crypto.randomBytes(8).toString('hex'),
        name: displayName,
        email,
        google_sub: googleSub,
        role: isHead ? 'head' : 'teacher',
        status: isHead ? 'approved' : 'pending',
        created_at: new Date().toISOString(),
      };
      const { data: inserted, error: insertErr } = await supabase.from('teachers').insert([newTeacher]).select().maybeSingle();
      if (insertErr) return res.status(200).json({ success: false, error: insertErr.message });
      teacher = inserted;
    }

    // Keep the latest Google profile photo on the teacher record.
    // This is cosmetic only; if the optional column is not migrated yet,
    // login continues normally.
    if (pictureUrl) {
      try {
        const { data: updatedTeacher } = await supabase
          .from('teachers')
          .update({ picture_url: pictureUrl })
          .eq('id', teacher.id)
          .select()
          .maybeSingle();
        if (updatedTeacher) teacher = updatedTeacher;
      } catch (e) {
        console.warn('Could not save Google profile picture:', e.message);
      }
    }

    if (teacher.status !== 'approved') {
      return res.status(200).json({ success: false, pending: true, error: 'Your account is registered and waiting for approval from the head teacher.' });
    }

    // ---- Log this login + detect new device/location, report to head ----
    const geo = await lookupGeo(req);
    const ip = geo.ip;
    const device = parseDevice(req.headers['user-agent']);
    const deviceKey = crypto.createHash('sha256').update(`${teacher.id}|${device}|${geo.city}|${geo.country}`).digest('hex');

    const { data: priorDevice } = await supabase.from('login_events').select('id').eq('teacher_id', teacher.id).eq('device_key', deviceKey).limit(1).maybeSingle();
    const isNewDevice = !priorDevice;

    const gpsLat = Number(deviceLocation?.latitude);
    const gpsLon = Number(deviceLocation?.longitude);
    const gpsAccuracy = Number(deviceLocation?.accuracy);
    const hasValidGps = Number.isFinite(gpsLat) && gpsLat >= -90 && gpsLat <= 90 &&
      Number.isFinite(gpsLon) && gpsLon >= -180 && gpsLon <= 180;
    const eventRow = {
      id: 'evt_' + crypto.randomBytes(8).toString('hex'),
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      ip,
      city: hasValidGps && deviceLocation?.city ? String(deviceLocation.city) : geo.city,
      region: hasValidGps && deviceLocation?.region ? String(deviceLocation.region) : geo.region,
      country: hasValidGps && deviceLocation?.country ? String(deviceLocation.country) : geo.country,
      latitude: hasValidGps ? gpsLat : geo.lat,
      longitude: hasValidGps ? gpsLon : geo.lon,
      location_accuracy_m: hasValidGps && Number.isFinite(gpsAccuracy) ? gpsAccuracy : null,
      location_source: hasValidGps ? 'browser-gps' : 'ip',
      device,
      device_key: deviceKey,
      is_new_device: isNewDevice,
      created_at: new Date().toISOString(),
    };
    const { error: evtErr } = await supabase.from('login_events').insert([eventRow]);
    if (evtErr) {
      // Table might not have region/latitude/longitude columns yet (migration
      // not run). Don't let that break login — retry with just the original
      // columns so login still works while location is degraded, not dead.
      console.error('login_events insert failed, retrying without geo columns —', evtErr.message);
      const { region, latitude, longitude, location_accuracy_m, location_source, ...basicRow } = eventRow;
      await supabase.from('login_events').insert([basicRow]);
    }

    const token = signSession({ id: teacher.id, name: teacher.name, role: teacher.role, sv: teacher.session_version || 0 });
    setSessionCookie(res, token);

    return res.status(200).json({
      success: true,
      teacher: { id: teacher.id, name: teacher.name, email: teacher.email, role: teacher.role },
    });
  } catch (err) {
    return res.status(200).json({ success: false, error: err.message });
  }
};
