// api/cron-sniper-morning.js — Vercel Cron → sniper-bot 'Sniper Daily' (cmd=morning)
import { dispatch } from './_sniper.js';
export default function handler(req, res) {
  return dispatch(req, res, 'sniper-daily.yml', { cmd: 'morning' });
}
