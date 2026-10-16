// api/cron-sniper-wave.js — Vercel Cron → sniper-bot 'Sniper Wave'
import { dispatch } from './_sniper.js';
export default function handler(req, res) {
  return dispatch(req, res, 'sniper-wave.yml', null);
}
