// api/cron-sniper-place.js — Vercel Cron → sniper-bot 'Sniper Daily' (cmd=place)
import { dispatch } from './_sniper.js';
export default function handler(req, res) {
  return dispatch(req, res, 'sniper-daily.yml', { cmd: 'place' });
}
